var argv = require("minimist")(process.argv.slice(2));
var clientFactory = require("ssb-client");
var config = require("ssb-config");
var pull = require("pull-stream");
var Pushable = require("pull-pushable");
var many = require("./pull-many-v2");

// Change to 'true' to get debugging output
DEBUG = false

// Change to switch the default monitored channel
DEFAULT_CHANNEL_NAME = "logbook"

DEFAULT_OPTS = {
	lt: Date.now(),
	gt: -Infinity
}
GRAPH_TYPE = "follow"
MAX_HOPS = 1


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
		this.idsInMainChannel = {},
		this.streamData = {
			channelStream: new StreamData(),
			hashtagStream: new StreamData()
		},

		this.pushMessage = function(source, newMsg) {
			var streamData = source == "hashtag" ? this.streamData.hashtagStream : this.streamData.channelStream;
			streamData.oldestTimestampSeen = newMsg.value.timestamp;

			if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
				this.idsInMainChannel[newMsg.value.author] = true;
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
		this.startExit = function() {
			for(var datumIndex in this.streamData) {
				this.streamData[datumIndex].oldestTimestampSeen = 0;
			}
			this.pushNewlySafeMessages();

			this.getRelevantProfilePictures();
		},
		this.finishExit = function() { // is called at the end of getRelevantProfilePictures
			this.outputStream.end();
			
			if(argv.d) {
				debug("delete flag detected, cleansing unrelated blobs...");
				this.deleteUnrelatedBlobs();
			}
			else {
				process.exit(0);
			}
		},
		this.requestBlobs = function(msg) {
			let client = this.client; // did the javascript devs ever consider that you might have a callback inside a member function? no? ok
			if(msg.value && msg.value.content) {
				if(msg.value.content.mentions && Symbol.iterator in Object(msg.value.content.mentions)) {
					for(let mention of msg.value.content.mentions) {
						if(mention.type && mention.link) {
							if(typeof mention.link == "string") {
								this.getBlob(mention.link)
							}
							else {
								debug("Message has non-string mention.link value: " + JSON.stringify(mention.link));
							}
						}
					}
				}
			}

		},
		this.getRelevantProfilePictures = function() {
			let javascriptSucksTheChromeOffOfDoorknobs = this;

			let relevantIds = Object.keys(this.idsInMainChannel);
			let profilePictureStreams = []
			let profilePictureFound = {};
			for(let userId of relevantIds) {
				profilePictureFound[userId] = false;
				profilePictureStreams.push(createMetadataStream(this.client, userId));
			}
			let collectedStream = many(profilePictureStreams);
			
			if(relevantIds.length == 0) { // avoid the edge case where checkIfDone is never called
				this.finishExit()
			}
			
			pull(
				collectedStream,
				pull.drain(function(item) {
					let msg = item.data;
					if(!profilePictureFound[item.source] && msg.value.content.image) { // the source of an item is the userId of the stream that item came from
						if(typeof msg.value.content.image == "string") {
							debug("Getting profile picture at " + msg.value.content.image + " for user " + item.source);
							javascriptSucksTheChromeOffOfDoorknobs.getBlob(msg.value.content.image);
							profilePictureFound[item.source] = true;
						}
						else if(typeof msg.value.content.image == "object" && typeof msg.value.content.image.link == "string") {
							debug("Getting profile picture at " + msg.value.content.image.link + " for user " + item.source);
							javascriptSucksTheChromeOffOfDoorknobs.getBlob(msg.value.content.image.link);
							profilePictureFound[item.source] = true;
						}
						else {
							debug("Message has unknown msg.value.content.image value: " + JSON.stringify(msg.value.content.image));
						}
					}
				}, function() {
					javascriptSucksTheChromeOffOfDoorknobs.finishExit();
				})
			);
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
				}, function() {
					process.exit(0);
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

function createHashtagStream(client, channelName) {
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

function createChannelStream(client, channelName) {
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

function createMetadataStream(client, userId) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                               		author: userId,
                                       	content: {
                                               	type: "about"
                                        	}
                        		}
       	        	}
                }]
	});

	query.streamName = userId; // mark the stream object so we can tell which stream a message came from later

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
			return !hasHashtag; // prevents us from double-counting messages with both the hashtag and the channel header (don't need to worry about 'about' messages since they never have text fields)
		}
	}), pull.drain(function(msg) {
		streamController.pushMessage(msg.source, msg.data);
	}, function() {
		streamController.startExit();
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

function getConfig() {
	return {
		host: config.host || "localhost",
		port: config.port || 8008
	}
}

clientFactory(getConfig(), function(err, client) {
	if(err) {
		console.log("[ERROR] Failed to open ssb-client: " + err);
	}

	if(argv["delete"] || argv["del"]) {
		argv.d = true;
	}
	main(client, argv._[0] || DEFAULT_CHANNEL_NAME, DEFAULT_OPTS, () => {});
});
