var clientFactory = require("ssb-client");
var config = require("ssb-config");
var pull = require("pull-stream");
var Pushable = require("pull-pushable");
var many = require("./pull-many-v2");

// Change to 'true' to get debugging output
DEBUG = !false

DEFAULT_OPTS = {
	lt: Date.now(),
	gt: -Infinity
}
GRAPH_TYPE = "follow"
MAX_HOPS = 1

// only instantiate a ssb-client once, so we don't have to create a new connection every time we load a channel page
let client = null;

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

class ChannelController {
	constructor(opts) {
		this.opts = opts,
		this.outputStream = Pushable(),
		this.allMessages = {},
		this.outputQueue = {},
		this.idsInChannel = {},
		this.streamData = {
			channelStream: new StreamData(),
			hashtagStream: new StreamData(),
		},

		this.getMessagesFrom = function(channelName, followedIds, preserve, cb) {
			var channelTag = "#" + channelName;
			var hashtagStream = createHashtagStream(channelTag);
			var channelStream = createChannelStream(channelName);
			var stream = many([hashtagStream, channelStream]);

			var self = this;
			pull(stream, pull.filter(function(msg) {
				return followedIds.includes(msg.data.value.author.toLowerCase());
			}), pull.filter(function(msg) {
				if(msg.data.value && msg.data.value.content && msg.data.value.content.channel && msg.data.value.content.channel == channelName) {
					return true;
				}

				// prevent ssb-search from grouping messages with #logbook and #logbook2 together, without running a double search
				if(msg.data.value && msg.data.value.content && msg.data.value.content.text) {
					let acceptableHashtags = [channelTag + "\n", channelTag + " "];
					for(let hashtag of acceptableHashtags) {
						if(msg.data.value.content.text.indexOf(hashtag) != -1) {
							return true
						}
					}

					return false;
				}
			}), pull.drain(function(msg) {
				self.pushMessage(msg.source, msg.data);
			}, function() {
				self.finish(followedIds);
			}));

			cb(this.outputStream, preserve);
		},
		this.pushMessage = function(msgSource, newMsg) {
			this.idsInChannel[newMsg.value.author] = true;
			var streamData = msgSource == "hashtag" ? this.streamData.hashtagStream : this.streamData.channelStream;
			streamData.oldestTimestampSeen = newMsg.value.timestamp;

			this.allMessages[newMsg.key] = newMsg; // regardless of time, we want to check for replies to this message
			if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
				streamData.waitingMessages.push(newMsg);
				requestBlobs(newMsg);
			}

			this.pushNewlySafeMessages();
		},
		this.pushNewlySafeMessages = function() {
			var newlySafeMessages = [];
			var oldestSafeTimestamp = Math.max(...Object.values(this.streamData).map(datum => datum.oldestTimestampSeen));
			debug("pushing messages from before " + oldestSafeTimestamp + "...");

			for(var streamDataIndex in this.streamData) {
				var streamDatum = this.streamData[streamDataIndex]
				while(streamDatum.waitingMessages.length && streamDatum.waitingMessages[0].value.timestamp >= oldestSafeTimestamp) {
					var safeMsg = streamDatum.waitingMessages.shift(); // pop the newest waiting message
					debug("pushing safe message with timestamp " + safeMsg.value.timestamp);
					newlySafeMessages.push(safeMsg);
				}
			}
			debug("pushed all newly safe messages");

			// in general, newlySafeMessages might not be in order, we should sort before appending
			newlySafeMessages.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));
			for(var msgIndex in newlySafeMessages) {
				// this.outputStream.push(newlySafeMessages[msgIndex]);
				this.outputQueue[newlySafeMessages[msgIndex].key] = newlySafeMessages[msgIndex];
			}
		},
		this.finish = function(followedIds) {
			for(var datumIndex in this.streamData) {
				this.streamData[datumIndex].oldestTimestampSeen = 0;
			}
			this.pushNewlySafeMessages();

			this.getReplies(followedIds);

			// this.outputStream.end();
		},
		this.getReplies = function(followedIds) {
			var backlinkStreams = [];
			for(const msgKey in this.allMessages) {
				backlinkStreams.push(getBacklinkStream(msgKey));
			}

			var self = this;
			debug("looking for backlinked messages...");
			var messagesToPush = [];
			pull(
				many(backlinkStreams),
				pull.filter(function(msg) {
					return !(msg.data.key in self.outputQueue) && (followedIds.includes(msg.data.value.author.toLowerCase()));
				}),
				pull.filter(function(msg) {
					debug("found backlink message: " + JSON.stringify(msg.data));
					return (msg.data.value.timestamp > self.opts.gt) && (msg.data.value.timestamp < self.opts.lt);
				}),
				pull.drain(function(msg) {
					debug("backlink message had correct timestamps: " + JSON.stringify(msg.data));
					if(!(msg.data.key in self.outputQueue)) {
						self.outputQueue[msg.data.key] = msg.data;
						// messagesToPush.push(msg.data);
					}
				}, function() {
					for(const msgKey in self.outputQueue) {
						debug("pushing message with key " + msgKey);
						//self.outputStream.push(self.outputQueue[msgKey]);
						messagesToPush.push(self.outputQueue[msgKey]);
					}	

					messagesToPush.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));

					for(var msg of messagesToPush) {
						self.outputStream.push(msg);
					}

					self.outputStream.end()
				})
			)
		}
	}
}

function requestBlobs(msg) {
	if(msg.value && msg.value.content) {
		if(msg.value.content.mentions && Symbol.iterator in Object(msg.value.content.mentions)) {
			for(let mention of msg.value.content.mentions) {
				if(mention.type && mention.link) {
					if(typeof mention.link == "string") {
						getBlob(mention.link)
					}
					else {
						debug("Message has non-string mention.link value: " + JSON.stringify(mention.link));
					}
				}
			}
		}
	}
}

function getProfilePicturesOf(relevantIds) {
	let profilePictureStreams = []
	let profilePictureFound = {};

	for(let userId of relevantIds) {
		profilePictureFound[userId] = false;
		profilePictureStreams.push(createMetadataStream(userId));
	}
	let collectedStream = many(profilePictureStreams);

	if(relevantIds.length == 0) { // avoid the edge case where checkIfDone is never called
		// exit(cb, preserve);
		return;
	}

	pull(
		collectedStream,
		pull.drain(function(msg) {
			if(!profilePictureFound[msg.value.author] && msg.value.content.image) {
				if(typeof msg.value.content.image == "string") {
					debug("Getting profile picture at " + msg.value.content.image + " for user " + msg.value.author);
					getBlob(msg.value.content.image);
					profilePictureFound[msg.value.author] = true;
				}
				else if(typeof msg.value.content.image == "object" && typeof msg.value.content.image.link == "string") {
					debug("Getting profile picture at " + msg.value.content.image.link + " for user " + msg.value.author);
					getBlob(msg.value.content.image.link);
					profilePictureFound[msg.value.author] = true;
				}
				else {
					debug("Message has unknown msg.value.content.image value: " + JSON.stringify(msg.value.content.image));
				}
			}
		})
	);
}

function getBlob(blobId) {
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
}

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[channels-lib] [" + timestamp.toISOString() + "] " +  message);
	}
}

function getBacklinkStream(msgId) {
	var q = {
		dest: msgId,
		reverse: true,
		values: true
	}

	return client.links(q);
}

function createHashtagStream(channelName) {
	var search = client.search && client.search.query;
        if(!search) {
                console.log("[FATAL] ssb-search plugin must be installed to us channels");
        }

        var query = search({
                query: channelName
        });

	query.streamName = "hashtag";

	return query;
}

/*function createHashtagStream(channelTag) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                                       	content: {
                                       		mentions: [
                                       			channelTag
                                       		]
                                        	}
                        		}
       	        	}
                }],
               reverse: true
	});

	return query;
}*/

function createChannelStream(channelName) {
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

	query.streamName = "channel";

	return query;
}

function createUserStream(userId) {
	var query = client.createUserStream({
		id: userId
	});

	return query;
}

function createMetadataStream(userId) {
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

function getConfig() {
	return {
		host: config.host || "localhost",
		port: config.port || 8008
	}
}

module.exports = {
	getMessages: function(ssbClient, channelName, ssbOpts, preserve, cb, hops=MAX_HOPS) {
		client = ssbClient;

		client.friends.hops({
			dunbar: Number.MAX_SAFE_INTEGER,
			max: hops
		}, function(error, friends) {
			if(error) {
				throw "Couldn't get a list of friends from scuttlebot:\n" + error;
			}

			var followedIds = Object.keys(friends).map(id => id.toLowerCase());
			let controller = new ChannelController(ssbOpts || DEFAULT_OPTS);
			controller.getMessagesFrom(channelName, followedIds, preserve, cb);
		});
	}
}
