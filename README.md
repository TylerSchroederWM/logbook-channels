# logbook-channels

logbook-channels is a utility to unify the two ways of adding messages to channels in Scuttlebutt: hashtags and channel headers.

The files in the repo are as follows:
- **pull-many-v2.js** is a utility that must be in the same directory as either *channels-v2.js* or *channels-lib.js*.
- **channels-v2.js** is a standalone command line utility. To print all messages in the `logbook` channel, run `node channels-v2.js logbook`.
- **channels-lib.js** provides channel messages from a pull-stream. Example usage would be:

```
const pull = require("pull-stream");
const clientFactory = require("ssb-client");
const channels = require("./channels-lib");

clientFactory(function(err, client) {
  if(err) throw err;
  channel.getMessages(client, "logbook", function(messageStream) {
    pull(messageStream, pull.drain(function(msg) {
      console.log(JSON.stringify(msg));
    })
  });
});
```

To integrate into Patchfoo:
```
Serve.prototype.logbook = function (ext) {
  var q = this.query
  var opts = {
    reverse: !q.forwards,
    //sortByTimestamp: q.sort === 'claimed',
    sortByTimestamp: q.sort || 'claimed',
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    filter: q.filter,
  }

  logbook.getMessages(this.app.sbot, "logbook", this, function(messageStream, serve) {
    pull(messageStream,
	    serve.renderThreadPaginated(opts, null, q),
	    serve.wrapMessages(),
	    serve.wrapPublic(),
	    serve.wrapPage('logbook'),
	    serve.respondSink(200, {
		    'Content-Type': ctype(ext)
	    })
	    //pull.drain(function(msg) {
		    //console.log(JSON.stringify(msg));
	    //})
    )
  }
  , hops=3)

	    //this.renderThreadPaginated(opts, null, q),
	    //this.wrapMessages(),
	    //this.wrapPublic(),
	    //this.wrapPage('public'),
	    //this.respondSink(200, {
		    //'Content-Type': ctype(ext)
	    //})
    //)
    //});

  //pull(
    //this.app.createLogStream(opts),
    //pull.filter(msg => {
      //return !msg.value.content.vote
    //}),
    //this.renderThreadPaginated(opts, null, q),
    //this.wrapMessages(),
    //this.wrapPublic(),
    //this.wrapPage('public'),
    //this.respondSink(200, {
      //'Content-Type': ctype(ext)
    //})
  //)
}
```Serve.prototype.logbook = function (ext) {
  var q = this.query
  var opts = {
    reverse: !q.forwards,
    //sortByTimestamp: q.sort === 'claimed',
    sortByTimestamp: q.sort || 'claimed',
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    filter: q.filter,
  }

  logbook.getMessages(this.app.sbot, "logbook", this, function(messageStream, serve) {
    pull(messageStream,
	    serve.renderThreadPaginated(opts, null, q),
	    serve.wrapMessages(),
	    serve.wrapPublic(),
	    serve.wrapPage('logbook'),
	    serve.respondSink(200, {
		    'Content-Type': ctype(ext)
	    })
	    //pull.drain(function(msg) {
		    //console.log(JSON.stringify(msg));
	    //})
    )
  }
  , hops=3)

	    //this.renderThreadPaginated(opts, null, q),
	    //this.wrapMessages(),
	    //this.wrapPublic(),
	    //this.wrapPage('public'),
	    //this.respondSink(200, {
		    //'Content-Type': ctype(ext)
	    //})
    //)
    //});

  //pull(
    //this.app.createLogStream(opts),
    //pull.filter(msg => {
      //return !msg.value.content.vote
    //}),
    //this.renderThreadPaginated(opts, null, q),
    //this.wrapMessages(),
    //this.wrapPublic(),
    //this.wrapPage('public'),
    //this.respondSink(200, {
      //'Content-Type': ctype(ext)
    //})
  //)
}
