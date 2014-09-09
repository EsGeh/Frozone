module Frozone.Util.Concurrency.Scheduling(
    Task(..), Tasks,
    Thread(..), Running,
    JobId(..), JobState(..),
    Forkable, fork,
    SchedData(),
    runScheduler,
    stopScheduler,
    addTask,
    removeJob,
    killAllJobs,
    waitForJob, waitForJobMaxTime,
) where

import Frozone.Util.Concurrency.Scheduling.Model

import Frozone.Util.Concurrency
import Frozone.Util.Logging
import qualified Frozone.Util.Queue as Q
import qualified Data.Map as M
import Data.Maybe
import Data.Either

import Control.Monad.Error

import Control.Monad.STM
import Control.Concurrent


class (MonadIO m) => Forkable m where
    fork :: m () -> m ThreadId

type ErrMsg = String


runScheduler :: Forkable m => Int -> (a -> m ()) -> m (SchedData a)
runScheduler maxThreads f =
    do doLog LogInfo $ "SCHEDULER: runScheduler"
       schedData <- liftIO $ atomically $ emptySchedulerData maxThreads
       threadId <- fork (scheduler schedData f)
       doLog LogInfo $ "SCHEDULER: end of runScheduler"
       return $
           schedData
           { sched_threadId = Just threadId
           }

{- |this stops the scheduler thread. If you want to kill all jobs as well, use killAllJobs before -}
stopScheduler :: (SchedData a) -> ErrorT ErrMsg IO ()
stopScheduler schedData =
    do let mThreadId = sched_threadId schedData
       doLog LogInfo $ "SCHEDULER: stop"
       case mThreadId of
         Nothing -> throwError "scheduler not running!"
         Just threadId ->
             do doLog LogInfo $ "SCHEDULER: killing scheduler thread"
                lift $ killThread threadId
       doLog LogInfo $ "SCHEDULER: end of stop"

scheduler :: Forkable m => SchedData a -> (a -> m b) -> m ()
scheduler schedData f =
    forever $
    do (jobId, nextTask) <- (liftIO . atomically . nextToRunning schedData) =<< liftIO myThreadId
       doLog LogInfo $ "SCHEDULER: adding " ++ show jobId
       fork $
           do f $ fromTask nextTask
              liftIO $ atomically $ removeFromRunning schedData jobId

addTask :: SchedData a -> Task a -> IO JobId
addTask schedData task =
    atomically $ addToTasks schedData task 

removeJob :: MonadIO m => SchedData a -> JobId -> ErrorT ErrMsg m ()
removeJob schedData jobId =
    do errOrMaybeThreadId <- liftIO $ atomically $
           removeJobPrivate schedData jobId
       case errOrMaybeThreadId of
         Left err -> throwError err
         Right (Just threadId) -> liftIO $ killThread threadId
         Right Nothing -> return ()

waitForJobMaxTime :: SchedData a -> TimeMs -> JobState -> JobId -> IO AwaitRes
waitForJobMaxTime schedData maxTime jobState jobId =
    case jobState of
      JobWaiting ->
          awaitMaxTime
            maxTime
            (\tasks -> not $ Q.null $ Q.filter (\(jobId',_) -> jobId' == jobId) $ tasks)
            (sched_tasks schedData)
      JobRunning -> awaitMaxTime maxTime (M.member jobId) (sched_running schedData)
      JobFinished ->
          awaitMaxTime maxTime (not . M.member jobId) (sched_running schedData)

waitForJob :: SchedData a -> JobState -> JobId -> IO ()
waitForJob schedData jobState jobId =
    case jobState of
      JobWaiting ->
          atomically $ await
            (\tasks -> not $ Q.null $ Q.filter (\(jobId',_) -> jobId' == jobId) $ tasks)
            (sched_tasks schedData)
      JobRunning ->
          atomically $
              await (M.member jobId) (sched_running schedData)
      JobFinished ->
          atomically $
              await (not . M.member jobId) (sched_running schedData)

killAllJobs :: SchedData a -> IO ()
killAllJobs schedData =
    do allThreadIds <-
           atomically $
           do (tasks, running) <- getAllJobs schedData
              mapM (removeJobPrivate schedData) $ tasks
              mapM (removeJobPrivate schedData) $ running
       mapM_ killThread $ catMaybes $ rights allThreadIds

removeJobPrivate schedData jobId =
    do mTaskOrThread <- getJob schedData jobId
       case mTaskOrThread of
         Nothing -> return $ Left $ "job " ++ show jobId ++ " not found!" :: STM (Either ErrMsg (Maybe ThreadId))
         Just taskOrThread ->
             case taskOrThread of
               Left _ ->
                 do removeJobFromModel schedData jobId
                    return $ Right $ Nothing
               Right thread -> 
                 do removeJobFromModel schedData jobId
                    return $ Right $ Just $ thread_id thread
 
{-
waitForAll :: TVar (Tasks a) -> TVar (Running a) -> IO ()
waitForAll refTasks refRunning =
    atomically $
    do tasks <- readTVar refTasks
       running <- readTVar refRunning
       if not (Q.null tasks && M.null running)
         then retry
         else return ()
-}
