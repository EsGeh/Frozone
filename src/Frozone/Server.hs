{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE DoAndIfThenElse #-}
module Frozone.Server where

import Frozone.Types
import Frozone.Model
import Frozone.BaseImage
import Frozone.Util.Logging
import Frozone.Util.Random
import Frozone.Util.Process

import Control.Concurrent
import Control.Concurrent.STM
import Control.Exception
import Control.Monad.Logger
import Control.Monad.Trans
import Control.Monad.Trans.Resource
import Data.Time
import Database.Persist.Sqlite hiding (get)
import Network.Email.Sendmail
import System.Directory
import System.Exit
import System.FilePath
import Web.PathPieces
import Web.Spock
import qualified Crypto.Hash.SHA1 as SHA1
import qualified Data.ByteString as BS
import qualified Data.ByteString.Base16 as B16
import qualified Data.ByteString.Char8 as BSC
import qualified Data.ByteString.Lazy as BSL
import qualified Data.HashSet as HS
import qualified Data.Text as T
import qualified Data.Text.IO as T
import qualified Data.Yaml as YML
import qualified Database.Persist as DB
import qualified Network.Wai.Parse as Wai

type FrozoneApp = SpockM Connection () FrozoneState ()
type FrozoneAction a = SpockAction Connection () FrozoneState a
type FrozoneWorker a = WebStateM Connection () FrozoneState a

runServer :: FrozoneConfig -> IO ()
runServer fc =
    do pool <- createSqlitePool (T.pack $ fc_sqliteFile fc) 5
       runNoLoggingT $ runSqlPool (runMigration migrateCore) pool
       baseImageBuildsVar <- newTVarIO HS.empty
       let fcState =
               FrozoneState
               { fs_config = fc
               , fs_baseImageBuildsVar = baseImageBuildsVar
               }
       spock (fc_httpPort fc) sessCfg (PCConduitPool pool) fcState serverApp
    where
      sessCfg =
          SessionCfg "FrozoneCookie" 3600 40 ()

runSQL action =
    runQuery $ \conn ->
        runResourceT $ runNoLoggingT $ runSqlConn action conn

createPosthook :: FrozoneState -> TempRepositoryId -> FilePath -> IO ()
createPosthook st repoId repoDir =
    do exists <- doesFileExist prefsFile
       baseCt <-
           if exists
           then do c <- readFile prefsFile
                   return (c ++ "\n")
           else return ""
       writeFile prefsFile (baseCt
                            ++ "apply posthook wget --quiet " ++ localServerApi ++ "\n"
                            ++ "apply run-posthook")
       doLog LogNote ("Created posthook on " ++ repoDir ++ ": Will notify " ++ localServerApi)
    where
      localServerApi =
          "http://127.0.0.1:" ++ show (fc_httpPort $ fs_config st) ++ "/posthook/" ++ (T.unpack $ toPathPiece repoId)
      prefsFile = repoDir </> "_darcs" </> "prefs" </> "defaults"

launchBuild :: FrozoneState -> (FrozoneWorker () -> IO ()) -> TempRepositoryId -> TempRepository -> IO ()
launchBuild st runAction repoId repo =
    catch runBuild (\(e :: SomeException) -> buildFailed (show e))
    where
      withDarcsChanges onErr fn =
          withProgResult "darcs" onErr ["changes", "--repodir", tempRepositoryPath repo] fn

      sendNotification subject msg =
          do let mailTarget = T.unpack $ tempRepositoryNotifyEmail repo
                 fireMail moreInfo =
                     do doLog LogInfo ("Sending mail to " ++ mailTarget ++ ": " ++ subject)
                        sendmail (Just "Frozone <thiemann@cp-med.com>") [ mailTarget ]
                                     ("Subject: Frozone: " ++ subject ++ "\r\n" ++ msg ++ "\n\n" ++ moreInfo)
             withDarcsChanges (\_ -> fireMail "darcs changes failed, so I have no Idea what patches are in you repo.") $ \changes ->
                 fireMail ("Patches in repository:\n\n" ++ changes)

      buildFailed reason =
          do doLog LogWarn ("Build " ++ show repoId
                            ++ " failed/crashed! Error: " ++ reason)
             _ <- ioSQL $ DB.update repoId [ TempRepositoryBuildSuccess =. (Just False)
                                           , TempRepositoryBuildMessage =. (Just (T.pack reason))
                                           ]
             sendNotification "[BAD] Build failed" ("Your build failed:\n\n " ++ reason)
             return ()

      ioSQL = runAction . runSQL

      runBuild =
          do yml <- YML.decodeFileEither (tempRepositoryPath repo </> ".frozone.yml")
             case yml of
               Left parseException ->
                   buildFailed ("Error in .frozone.yml: " ++ show parseException)
               Right repoCfg ->
                   do cabalOk <- doesFileExist (tempRepositoryPath repo </> rc_cabalFile repoCfg)
                      if cabalOk
                      then do cabalBS <- BS.readFile (tempRepositoryPath repo </> rc_cabalFile repoCfg)
                              mBaseImage <- ensureBaseImageExists (fs_baseImageBuildsVar st) repoCfg cabalBS
                              case mBaseImage of
                                Left errMsg ->
                                    buildFailed ("Something went wrong while trying to build the base image:\n" ++ errMsg)
                                Right baseImage ->
                                    prepareDockerFile baseImage
                      else buildFailed ("Your cabal file " ++ rc_cabalFile repoCfg ++ "doesn't exist")

      prepareDockerFile baseImage =
          do let dockerPath = (tempRepositoryPath repo </> "Dockerfile")
                 baseImgTag = "$$BASE_IMAGE$$"
             dockerOk <- doesFileExist dockerPath
             if dockerOk
             then do dockerfile <- T.readFile dockerPath
                     if T.isInfixOf baseImgTag dockerfile
                     then do T.writeFile dockerPath (T.replace baseImgTag baseImage dockerfile)
                             runDockerBuild
                     else buildFailed ("Missing 'FROM " ++ (T.unpack baseImgTag) ++ "' in your Dockerfile!")
             else buildFailed "Missing a Dockerfile in your Repository root."

      runDockerBuild =
          do doLog LogNote ("Starting to build " ++ show repoId)
             now <- getCurrentTime
             ioSQL $ DB.update repoId [TempRepositoryBuildStartedOn =. (Just now)]
             withDarcsChanges (\_ -> buildFailed "darcs changes failed!") $ \changes ->
                 do let dockerImageId = BSC.unpack $ B16.encode $ SHA1.hash $ BSC.pack changes
                        imageName = "frozone/build-" ++ dockerImageId
                    (ec, stdout, stderr) <-
                        runProc "docker" ["build", "-rm", "-t", imageName, tempRepositoryPath repo]
                    case ec of
                      ExitFailure _ ->
                          buildFailed (stdout ++ "\n \n" ++ stderr)
                      ExitSuccess ->
                          do doLog LogNote ("Dockerbuild of " ++ show repoId ++ " complete! Image: " ++ imageName)
                             ioSQL $ DB.update repoId [ TempRepositoryBuildSuccess =. (Just True)
                                                      , TempRepositoryBuildMessage =. (Just (T.pack stdout))
                                                      , TempRepositoryDockerImage =. (Just (T.pack imageName))
                                                      ]
                             sendNotification "[GOOD] Build ok!" "Everything is cool, bro!"

mkTempRepo :: String -> T.Text -> (FilePath -> FrozoneAction ()) -> FrozoneAction ()
mkTempRepo repo email otherAction =
    do st <- getState
       targetIdent <- liftIO $ randomB16Ident 10
       let targetDir = (fc_storageDir $ fs_config st) </> targetIdent
           withDarcs = withProgResult "darcs" (json . FrozoneError . T.pack)
       withDarcs ["get", "--lazy", repo, targetDir] $ \_ ->
           do now <- liftIO getCurrentTime
              let rp =
                      TempRepository
                      { tempRepositoryBranch = T.pack repo
                      , tempRepositoryPath = targetDir
                      , tempRepositoryCreatedOn = now
                      , tempRepositoryNotifyEmail = email
                      , tempRepositoryBuildStartedOn = Nothing
                      , tempRepositoryBuildSuccess = Nothing
                      , tempRepositoryBuildMessage = Nothing
                      , tempRepositoryDockerImage = Nothing
                      , tempRepositoryDockerContainer = Nothing
                      }
              dbId <- runSQL $ DB.insert rp
              liftIO $ createPosthook st dbId targetDir
              otherAction targetDir
              json (FrozoneRepoCreated (T.pack targetDir))

serverApp :: FrozoneApp
serverApp =
    do get "/posthook/:repoId" $
         do repoId <- paramPathPiece "repoId"
            mRepo <- runSQL $ DB.get repoId
            case mRepo of
              Nothing ->
                  do liftIO $ doLog LogWarn ("Failed to run posthook! Unkown repo: " ++ show repoId)
                     json (FrozoneError "Unknown repository!")
              Just repo ->
                  case tempRepositoryBuildStartedOn repo of
                    Just _ ->
                        do liftIO $ doLog LogWarn ("Posthook for " ++ tempRepositoryPath repo
                                                   ++ " called multiple times! Ignoring.")
                           json (FrozoneError "Already called")
                    Nothing ->
                        do spockHeart <- getSpockHeart
                           st <- getState
                           liftIO $
                             do doLog LogNote ("Will schedule build for " ++ tempRepositoryPath repo)
                                _ <- forkIO (launchBuild st (runSpockIO spockHeart) repoId repo)
                                return ()
                           json (FrozoneMessage ("Triggering build in " `T.append` (T.pack $ tempRepositoryPath repo)))

       post "/check-bundle" $
         do repo <- param "target-repo"
            email <- param "email"
            allFiles <- files
            case lookup "patch-bundle" allFiles of
              Just patchBundle ->
                  mkTempRepo repo email $ \repoPath ->
                      do liftIO $ BS.writeFile (repoPath </> "patches.dpatch") (BSL.toStrict $ Wai.fileContent patchBundle)
                         let withDarcs = withProgResult "darcs" (json . FrozoneError . T.pack)
                         withDarcs ["apply", "--repodir", repoPath, repoPath </> "patches.dpatch"] $ \_ ->
                             liftIO $ doLog LogInfo ("Patches applied!")
              Nothing ->
                  json (FrozoneError "No patch-bundle sent!")

       post "/new-push-target" $
         do repo <- param "target-repo"
            email <- param "email"
            mkTempRepo repo email (const $ return ())
