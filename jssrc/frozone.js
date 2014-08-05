/** @jsx React.DOM */

function ajaxHelper(url, onSuccess, onFail) {
    $.ajax({
        url: url,
        dataType: 'json',
        success: onSuccess,
        error: function(xhr, status, err) {
            console.error("Ajax failed: " + url, status, err.toString());
            if (onFail) {
                onFail();
            }
        }
    });
}

var FrozoneBuildBadge = React.createClass({
    render: function() {
        var st = this.props.state;

        var className = "label ";
        if (st == "failed" || st == "canceled" ) {
            className += "label-danger";
        } else if (st == "review-rejected" || st == "recheck") {
            className += "label-warning";
        } else if (st == "enqueued" || st == "preparing" || st == "started" || st == "in-review") {
            className += "label-info";
        } else if (st == "success" || st == "review-okay" || st == "applied") {
            className += "label-success";
        } else {
            className += "label-default";
        }
        return (<span className={className}>{st}</span>);
    }
});

var FrozoneCollection = React.createClass({
    getInitialState: function() {
        return {
            patches: [],
            builds: {},
            collection: null
        }
    },

    fetchData: function() {
        ajaxHelper("/api/collection/" + this.props.collectionId, function (collection) {
            this.setState({
                collection: collection
            });
        }.bind(this));
        ajaxHelper("/api/collection/" + this.props.collectionId + "/patches", function (patches) {
            this.setState({
                patches: patches
            });
            patches.map(function(p) {
                ajaxHelper("/api/build/patch/" + p.key, function (buildIds) {
                    var builds = this.state.builds;
                    builds[p.key] = buildIds;
                    this.setState({
                        builds: builds
                    });
                }.bind(this));
            }.bind(this));
        }.bind(this));
    },

    componentDidMount: function() {
        this.fetchData();
    },

    closeCollection: function() {
        ajaxHelper("/api/collection/" + this.props.collectionId + "/close", function() {
            this.fetchData();
        }.bind(this));
    },

    render: function() {
        var c = this.state.collection;
        var buildRows = this.state.patches.map(function (p) {
            var buildIds = (this.state.builds.hasOwnProperty(p.key) ? this.state.builds[p.key] : []);
            var buildLinks = buildIds.map(function (b) {
                return (<li key={b.key}>
                    <a href={"#/build/" + b.key}><FrozoneBuildBadge state={b.value.state} /> #{b.key}</a>
                </li>);
            });

            return (<tr key={p.key}>
                <td>{p.value.date}</td>
                <td>{p.value.name}</td>
                <td>{p.value.author}</td>
                <td>
                    <ul className="list-unstyled">
                        {buildLinks}
                    </ul>
                </td>
            </tr>);
        }.bind(this));

        var className = "label label-success";
        var stateDesc = "open";
        var canClose = true;
        if (c && !c.open) {
            className = "label label-danger";
            stateDesc = "closed";
            canClose = false;
        }

        return (<div>
            <div className="buildHeader clearFix">
                <h2 className="pull-left">
                    <h2><span className={className}>{stateDesc}</span> Collection: {c ? c.name : "Loading..."}</h2>
                </h2>

                <div className="buildButtons pull-right">
                    <button type="button" className="btn btn-danger" disabled={!canClose} onClick={this.closeCollection}>Close collection</button>
                </div>
            </div>

            <table className="table table-hover">
                <thead>
                <tr>
                    <th>Date</th>
                    <th>Patch</th>
                    <th>Author</th>
                    <th>Builds</th>
                </tr>
                </thead>
                <tbody>
                    {buildRows}
                </tbody>
            </table>
        </div>)
    }
});

var FrozoneBuildRow = React.createClass({
    getInitialState: function() {
        return {
            canceled: false,
            patch: null
        }
    },

    componentDidMount: function() {
        this.fetchData();
    },

    fetchData: function() {
        ajaxHelper("/api/patch/" + this.props.build.value.patch, function(data) {
            this.setState({ builds: data, patch: data });
        }.bind(this));
    },

    render: function() {
        var build = this.props.build;

        var badge = <FrozoneBuildBadge state={build.value.state} />;

        return (<tr>
            <th>{build.key}</th>
            <td>{build.value.createdOn}</td>
            <td>
                <a href={"#/build/" + build.key} title="More Information">
                    {this.state.patch ? this.state.patch.name : "Loading..."}
                </a>
            </td>
            <td>{badge}</td>
            </tr>);
    }
});

var FrozoneOverview = React.createClass({
    getInitialState: function() {
        return {
            builds: []
        }
    },

    fetchData: function() {
        ajaxHelper("/api/list-builds", function(data) {
            this.setState({ builds: data });
        }.bind(this));
    },

    componentDidMount: function() {
        this.props.timer = setInterval(this.fetchData, 10000);
        this.fetchData();
    },

    componentWillUnmount: function() {
        clearInterval(this.props.timer);
    },

    render: function() {
        var buildRows = this.state.builds.map(function (build) {
            return (<FrozoneBuildRow key={build.key} build={build} />);
        });

        return (<table className="table table-hover">
            <thead>
            <tr>
                <th>ID</th>
                <th>Created on</th>
                <th>Patch</th>
                <th>Status</th>
            </tr>
            </thead>
            <tbody>
                {buildRows}
            </tbody>
        </table>);
    }
});

var FrozoneLoading = React.createClass({
    render: function() {
        var s = {"text-align": "center"};

        return (<div style={s}><img src="/img/loading-bar.gif" /></div>);
    }
});

var FrozoneBuildDetails = React.createClass({
    getInitialState: function() {
        return {
            dataState: "loading",
            filesChanged: [],
            logMessages: [],
            build: null,
            patch: null
        };
    },

    fetchData: function() {
        ajaxHelper("/api/build/" + this.props.buildId, function(data) {
            if (data.error) {
                console.error(data.error);
                this.setState({ dataState: "error" });
            } else {
                this.setState({ dataState: "ok", build: data });
                ajaxHelper("/api/patch/" + data.patch, function(data) {
                    if (!data.error) {
                        this.setState({ patch: data });
                    }
                }.bind(this));
            }
        }.bind(this), function() {
            this.setState({ dataState: "error" });
        }.bind(this));
    },

    getChangedFiles: function() {
        ajaxHelper("/api/build/" + this.props.buildId + "/file-changes", function(data) {
            this.setState({ filesChanged: data });
        }.bind(this));
    },

    getLogHistory: function() {
        ajaxHelper("/api/build/" + this.props.buildId + "/logs", function(data) {
            this.setState({ logMessages: data });
        }.bind(this));
    },

    cancel: function(e) {
        e.preventDefault();
        var b = this.state.build;
        ajaxHelper("/api/build/" + this.props.buildId + "/cancel", function(data) {
            this.fetchData();
        }.bind(this));
    },

    rebuild: function(e) {
        e.preventDefault();
        var b = this.state.build;
        ajaxHelper("/api/build/" + this.props.buildId + "/rebuild", function(data) {
            this.fetchData();
        }.bind(this));
    },

    componentDidMount: function() {
        this.props.timer = setInterval(function() {
            this.fetchData();
            this.getLogHistory();
            this.getChangedFiles();
        }.bind(this), 10000);

        this.fetchData();
        this.getChangedFiles();
        this.getLogHistory();
    },

    componentWillUnmount: function() {
        clearInterval(this.props.timer);
    },

    render: function() {
        if (this.state.dataState === "loading") {
            return <FrozoneLoading />;
        } else if (this.state.dataState === "error") {
            return (<h2>404 Build not found</h2>);
        } else {
            var b = this.state.build;
            var p = this.state.patch;

            var cancelBox = <span></span>;
            var canCancel = true;
            if(b.state == "canceled") {
                canCancel = false;
                cancelBox = (<div className="alert alert-danger" role="alert">
                    <strong>Patch was canceled!</strong>
                </div>);
            }

            var canReview = (b.state == "success");
            var canRebuild = (b.state != "enqueued" && b.state != "preparing" && b.state != "started");

            var filesChanged = this.state.filesChanged.map(function (change) {
                var label = <span className="label label-info">M</span>;
                if (!change.value.oldContents) {
                    label = <span className="label label-success">A</span>;
                }
                if (!change.value.newContents) {
                    label = <span className="label label-danger">R</span>;
                }

                return (<li key={change.key}>
                    {label} {change.value.filename}
                </li>);
            });

            var logMessages = this.state.logMessages.map(function (logMessage) {
                return (<tr key={logMessage.key}>
                    <td>
                        <h5><FrozoneBuildBadge state={logMessage.value.state} /> {logMessage.value.time}</h5>
                        <pre>{logMessage.value.message}</pre>
                    </td>
                </tr>);
            });

            return (<div>
            <div className="buildHeader clearFix">
                <h2 className="pull-left">
                    <FrozoneBuildBadge state={b.state} /> {p ? p.name : "?"} (#{this.props.buildId})
                </h2>

                <div className="buildButtons pull-right">
                    <button type="button" className="btn btn-info" disabled={!canRebuild} onClick={this.rebuild}>Rebuild patch</button>
                    <button type="button" className="btn btn-danger" disabled={!canCancel} onClick={this.cancel}>Cancel patch</button>
                    <a className="btn btn-info" disabled={!canReview} href={"#/build/" + this.props.buildId +"/review"}>Review patch</a>
                    <button type="button" className="btn btn-success" disabled={true}>Apply patch</button>
                </div>
            </div>

            {cancelBox}

                <table className="table">
                    <tr>
                        <th>Interested People</th>
                        <td>{b.notifyEmail.join(", ")}</td>
                    </tr>
                    <tr>
                        <th>Branch</th>
                        <td>{b.branch}</td>
                    </tr>
                    <tr>
                        <th>Created on</th>
                        <td>{b.createdOn}</td>
                    </tr>
                    <tr>
                        <th>Changes-Hash</th>
                        <td>{b.changesHash}</td>
                    </tr>
                    <tr>
                        <th>Docker-Image</th>
                        <td>{b.dockerImage ? b.dockerImage : "-"}</td>
                    </tr>
                    <tr>
                        <th>Patch Collection</th>
                        <td><a href={(p ? "#/collection/" + p.group : "#")}>#{p ? p.group : "?"}</a></td>
                    </tr>
                </table>

                <h3>Files</h3>
                <ul className="list-unstyled">{filesChanged}</ul>

                <h3>Lifecycle</h3>
                <table className="table">
                    <tbody>
                        {logMessages}
                    </tbody>
                </table>
            </div>);
        }
    }
});

var FrozoneReview = React.createClass({
    getInitialState: function() {
        return {
            filesChanged: [],
            loaded: false
        }
    },

    getChangedFiles: function() {
        $.ajax({
            url: "/api/build/" + this.props.buildId + "/file-changes",
            dataType: 'json',
            success: function(data) {
                this.setState({ filesChanged: data, loaded: true });
            }.bind(this),
            error: function(xhr, status, err) {
                console.error("get-file-changes-" + this.props.buildId, status, err.toString());
                this.setState({ filesChanged: [] });
            }.bind(this)
        });
    },

    componentDidMount: function() {
        this.getChangedFiles();
    },

    render: function() {
        if (!this.state.loaded) {
            return (<FrozoneLoading />);
        }

        return (<div>
        <div className="buildHeader clearFix">
            <h2 className="pull-left">Review #{this.props.buildId}</h2>

            <div className="buildButtons pull-right">
                <button type="button" className="btn btn-danger" disabled={!canCancel} onClick={this.cancel}>Cancel patch</button>
                <a className="btn btn-info" disabled={!canReview} href={"#/build/" + this.props.buildId +"/review"}>Review patch</a>
                <button type="button" className="btn btn-success" disabled={true}>Apply patch</button>
            </div>
        </div>
        </div>);
    }
});

$(function() {
    /*
    * ROUTING
    */
    var renderComp = function(x) {
        React.renderComponent(x, document.getElementById('page-content'));
    }
    crossroads.addRoute('home', function () {
        renderComp(<FrozoneOverview />);
    });
    crossroads.addRoute('build/{build}', function (buildId) {
        renderComp(<FrozoneBuildDetails buildId={buildId} />);
    });
    crossroads.addRoute('build/{build}/review', function (buildId) {
        renderComp(<FrozoneReview buildId={buildId} />);
    });
    crossroads.addRoute('collection/{collectionId}', function (collectionId) {
        renderComp(<FrozoneCollection collectionId={collectionId} />);
    });

    //setup hasher
    function parseHash(newHash, oldHash){
        crossroads.parse(newHash);
    }
    function onHasherInit(curHash){
        if (curHash == '') {
            hasher.replaceHash('home');
        }
    }
    hasher.initialized.add(onHasherInit);
    hasher.initialized.add(parseHash);
    hasher.changed.add(parseHash);
    hasher.init();
});
