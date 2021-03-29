var argv = require("minimist")(process.argv.slice(2));
var clientFactory = require("ssb-client");
var pull = require("pull-stream");
var Pushable = require("pull-pushable");
var many = require("./pull-many-v2");

// Change to 'true' to get debugging output
DEBUG = !false

// Change to switch the default monitored channel
DEFAULT_CHANNEL_NAME = "logbook"

DEFAULT_OPTS = {
	lt: Date.now(),
	gt: -Infinity
}
GRAPH_TYPE = "follow"
MAX_HOPS = 3


class StreamData {
	constructor() {
		this.finished = false,
		this.oldestTimestampSeen = Number.MAX_SAFE_INTEGER,
		this.waitingMessages = []

		this.markFinished = function() {
			this.finished = true,
			this.oldestTimestampSeen = 0
		}
	}
}

class StreamController {
	constructor(client, opts) {
		this.client = client,
		this.outputStream = Pushable(),
		this.allowedBlobs = [],
		this.streamData = {
			channelStream: new StreamData(),
			hashtagStream: new StreamData(),
		},

		this.pushMessage = function(source, newMsg) {
			var streamData = source == "hashtag" ? this.streamData.hashtagStream : this.streamData.channelStream;
			streamData.oldestTimestampSeen = newMsg.value.timestamp;
			if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
				streamData.waitingMessages.push(newMsg);
			}

			this.pushNewlySafeMessages();
		},
		this.pushNewlySafeMessages = function() {
			var newlySafeMessages = [];
			var oldestSafeTimestamp = Math.max(...Object.values(this.streamData).map(datum => datum.oldestTimestampSeen));

			for(var streamDataIndex in this.streamData) {
				var streamDatum = this.streamData[streamDataIndex]
				while(streamDatum.waitingMessages.length && streamDatum.waitingMessages[0].value.timestamp >= oldestSafeTimestamp) {
					var safeMsg = streamDatum.waitingMessages.shift(); // pop the newest waiting message
					newlySafeMessages.push(safeMsg);
				}
			}

			// in general, newlySafeMessages might not be in order, we should sort before appending
			newlySafeMessages.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));
			for(var msgIndex in newlySafeMessages) {
				this.outputStream.push(newlySafeMessages[msgIndex]);
				this.requestBlobs(newlySafeMessages[msgIndex]);
			}
		},
		this.finish = function() {
			for(var datumIndex in this.streamData) {
				this.streamData[datumIndex].oldestTimestampSeen = 0;
			}
			this.pushNewlySafeMessages();

			this.deleteUnrelatedBlobs();

			this.outputStream.end();
		},
		this.requestBlobs = function(msg) {
			let client = this.client; // did the javascript devs ever consider that you might have a callback inside a member function? no? ok
			if(msg.value && msg.value.content) {
				if(msg.value.content.mentions) {
					for(let mention of msg.value.content.mentions) {
						if(mention.type && mention.link) {
							this.getBlob(mention.link)
						}
					}
				}

				if(msg.value.content.image) {
					this.getBlob(msg.value.content.image);
				}
			}
		},
		this.getBlob = function(blobId) {
			this.allowedBlobs.push(blobId);

			debug("Ensuring existence of blob with ID " + blobId);
			client.blobs.has(blobId, function(err, has) {
				if(err) {
					debug("[ERROR] ssb.blobs.has failed on the blob with ID " + blobId);
				}
				if(!err && !has) {
					debug("Wanting blob with ID " + blobId);
					client.blobs.want(blobId, () => {});
				}
			});
		},
		this.deleteUnrelatedBlobs = function() {
			let allowedBlobs = this.allowedBlobs; // did javascript devs ever anticipate anyone having an object function with a callback? no? ok
			pull(
				client.blobs.ls(),
				pull.filter(function(id) {
					return !allowedBlobs.includes(id);
				}),
				pull.drain(function(id) {
					client.blobs.rm(id, function () {
						debug("Removed blob with ID " + id);
					});
				})
			);
		}
	}
}

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[channels-lib] [" + timestamp.toISOString() + "] " +  message);
	}
}

function createHashtagStream(client, channelName, opts) {
	var search = client.search && client.search.query;
        if(!search) {
                console.log("[FATAL] ssb-search plugin must be installed to us channels");
                process.exit(5);
        }

        var query = search({
                query: channelName
        });

	query.streamName = "hashtag"; // mark the stream object so we can tell which stream an object came from

	return query;
}

function createChannelStream(client, channelName, opts) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                                       	content: {
                                               	channel: channelName
                                        	}
                        		}
       	        	}
                }],
               reverse: true
	});

	query.streamName = "channel"; // mark the stream object so we can tell which stream a message came from later

	return query;
}

function getMessagesFrom(client, channelName, followedIds, opts, cb) {
	var channelTag = "#" + channelName;
	var streamController = new StreamController(client, opts);
	var hashtagStream = createHashtagStream(client, channelName);
	var channelStream = createChannelStream(client, channelName);
	var stream = many([hashtagStream, channelStream]);

	pull(stream, pull.filter(function(msg) {
		return followedIds.includes(msg.data.value.author.toLowerCase());
	}), pull.filter(function(msg) {
		var hasHashtag =  msg.data.value.content && msg.data.value.content.text && typeof(msg.data.value.content.text) == "string" && msg.data.value.content.text.includes(channelTag);
		if(msg.source == "hashtag") {
			return hasHashtag;
		}
		else {
			return !hasHashtag; // prevents us from double-counting messages with both the hashtag and the channel header
		}
	}), pull.drain(function(msg) {
		streamController.pushMessage(msg.source, msg.data);
	}, function() {
		streamController.finish();
	}));

	cb(streamController.outputStream);
}

function main(client, channelName, opts, cb, hops=MAX_HOPS) {
	client.friends.hops({
		dunbar: Number.MAX_SAFE_INTEGER,
		max: hops
	}, function(error, friends) {
		if(error) {
			throw "Couldn't get a list of friends from scuttlebot:\n" + error;
		}

		var followedIds = Object.keys(friends).map(id => id.toLowerCase());
		getMessagesFrom(client, channelName, followedIds, opts, cb);
	});
}

clientFactory(function(err, client) {
	if(err) {
		console.log("[ERROR] Failed to open ssb-client: " + err);
	}
	main(client, argv._[0] || DEFAULT_CHANNEL_NAME, DEFAULT_OPTS, () => {});
});
