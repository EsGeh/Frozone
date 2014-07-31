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
            <td>{this.state.patch ? this.state.patch.name : "Loading..."}</td>
            <td>{badge}</td>
            <td>
                <a href={"#/build/" + build.key} title="More Information">
                    <i className="fa fa-info-circle"></i>
                </a>
            </td>
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
                <th>Actions</th>
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

    componentDidMount: function() {
        this.props.timer = setInterval(function() {
            this.fetchData();
            this.getLogHistory();
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

            var canReview = !!(b.State == "success");

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
                        <code>{logMessage.value.message}</code>
                    </td>
                </tr>);
            });

            return (<div>
            <div className="buildHeader clearFix">
                <h2 className="pull-left">
                    <FrozoneBuildBadge state={b.state} /> {p ? p.name : "?"} (#{this.props.buildId})
                </h2>

                <div className="buildButtons pull-right">
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
