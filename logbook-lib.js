var clientFactory = require("ssb-client");
var config = require("ssb-config");
var fs = require("fs");
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

CACHE_FILEPATH = "./"

// only instantiate a ssb-client once, so we don't have to create a new connection every time we load a channel page
let client = null;
let memoryCache = {}

class ChannelController {
	constructor(opts) {
		this.opts = opts,
		this.outputStream = Pushable(),
		this.rootMessages = [],
		this.outputQueue = [],
		this.idsInChannel = {},
		this.streamOpen = {
			"channel": true,
			"hashtag": true,
		},

		this.getMessagesFrom = function(mostRecentCachedTimestamp, rootMessages, allMessages, channelName, followedIds, preserve, cb) {
			var channelTag = "#" + channelName;
			var hashtagStream = createHashtagStream(channelTag);
			var channelStream = createChannelStream(channelName);
			var stream = many([hashtagStream, channelStream]);

			this.channelName = channelName;
			this.rootMessages = rootMessages;
			this.allMessages = allMessages;
			this.mostRecentCachedTimestamp = mostRecentCachedTimestamp;

			var self = this;
			pull(stream, pull.filter(function(msg) {
				return followedIds.includes(msg.data.value.author.toLowerCase());
			}), pull.filter(function(msg) {
				if(msg.data.value && msg.data.value.content && msg.data.value.content.channel && msg.data.value.content.channel == channelName) {
					return true;
				}

				// ignore every message from a stream that's before the ones we cached
				if(self.streamOpen[msg.source]) {
					if(msg.data.value.timestamp <= self.mostRecentCachedTimestamp) {
						self.streamOpen[msg.source] = false;
						for(var manyStream of stream.inputs) {
							if(manyStream.read.streamName == msg.source) {
								manyStream.ended = true; // forcefully end stream from ssb side
								break; // will never be more than one stream with the same name
							}
						}
						debug("found last new message from stream " + msg.source);

						let finished = true;
						for(var manyStream of stream.inputs) {
							finished = finished && manyStream.ended;
						}

						if(finished) {
							debug("all streams finished; exiting...");
							stream.end; // idk if this will actually work
						}
						return false; // don't return the first message we've already seen either
					}
				}
				else {
					return false;
				}

				// filter out false positives from ssb-query's loose text matching
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
				self.getReplies(followedIds);
			}));

			cb(this.outputStream, preserve);
		},
		this.pushMessage = function(msgSource, newMsg) {
			this.idsInChannel[newMsg.value.author] = true;

			this.rootMessages.push(newMsg); // regardless of timestamp, we want to look for replies to this message
			if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
				requestBlobs(newMsg);
				debug("pushing message with key " + newMsg.key);
				this.outputQueue.push(newMsg);
			}
		},
		this.getReplies = function(followedIds) {
			var backlinkStreams = [];
			debug("creating backlink streams");
			for(const msg in this.rootMessages) {
				backlinkStreams.push(getBacklinkStream(msg.key));
			}

			var self = this;
			var channelTag = "#" + this.channelName;
			debug("looking for backlinked messages...");
			pull(
				many(backlinkStreams),
				pull.filter(function(msg) {
					debug("checking backlinked message " + JSON.stringify(msg));
					return msg.data.value && msg.data.value.content && msg.data.value.content.text && (msg.data.value.content.text.indexOf(channelTag) == -1) && !(msg.data.value.content.channelName == self.channelName) && (followedIds.includes(msg.data.value.author.toLowerCase()));
				}),
				pull.filter(function(msg) {
					debug("found backlink message: " + JSON.stringify(msg.data));
					return (msg.data.value.timestamp > self.opts.gt) && (msg.data.value.timestamp < self.opts.lt);
				}),
				pull.drain(function(msg) {
					debug("backlink message had correct timestamps: " + JSON.stringify(msg.data));
					self.outputQueue.push(msg.data);
				}, function() {
					self.outputQueue.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));
					debug("done sorting messages");

					memoryCache[self.channelName] = self.outputQueue;
					for(var msg of self.outputQueue) {
						self.outputStream.push(msg);
					}

					fs.writeFile(CACHE_FILEPATH + self.channelName + ".txt", JSON.stringify({"root": self.rootMessages, "allMessages": self.outputQueue}), (error) => {
						if(error) {
							debug("[ERROR] Failed writing to message cache: " + error);
						}
						else {
							debug("Successfully saved messages to " + CACHE_FILEPATH + self.channelName + ".txt");
						}
					})

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

/*function createHashtagStream(channelName) {
	var search = client.search && client.search.query;
        if(!search) {
                console.log("[FATAL] ssb-search plugin must be installed to use channels");
        }

        var query = search({
                query: channelName
        });

	query.streamName = "hashtag";

	return query;
}*/

function createHashtagStream(channelName) {
	var query = client.query.read({
		"$filter": {
			value: {
				content: {
					text: channelName
				}
			}
		}
	});

	query.streamName = "hashtag";

	return query;
}

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

function createHashtagStreamOld(channelName) {
	var query = client.query.read({
		"$filter": {
			value: {
				content: {
					text: channelName
				}
			}
		}
	});

	query.streamName = "hashtag";

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
		debug("getting messages from #" + channelName);

		if(channelName in memoryCache && 'lt' in ssbOpts) {
			debug("already fetched messages from this channel");
			let outputStream = Pushable();
			ssbOpts = ssbOpts || DEFAULT_OPTS
			let limit = ssbOpts.limit || 10

			for(let msg of memoryCache[channelName]) {
				if(msg.value.timestamp < ssbOpts.lt && msg.value.timestamp > ssbOpts.gt) {
					outputStream.push(msg);
					limit -= 1;
					if(limit == 0) {
						break;
					}
				}
			}

			cb(outputStream, preserve);
		}
		else {
			var mostRecentCachedTimestamp = -Infinity;
			var rootMessages = [];
			var allMessages = [];
			if (fs.existsSync(CACHE_FILEPATH + channelName + ".txt")) {
				cache = JSON.parse(fs.readFileSync(CACHE_FILEPATH + channelName + ".txt"));
				if (cache.root.length) {
					mostRecentCachedTimestamp = cache.root[0].value.timestamp;
					rootMessages = cache.root;
					allMessages = cache.allMessages;
				}
				debug("successfully read messages from cache");
			}

			client.friends.hops({
				dunbar: Number.MAX_SAFE_INTEGER,
				max: hops
			}, function(error, friends) {
				if(error) {
					throw "Couldn't get a list of friends from scuttlebot:\n" + error;
				}

				var followedIds = Object.keys(friends).map(id => id.toLowerCase());
				let controller = new ChannelController(ssbOpts || DEFAULT_OPTS);
				controller.getMessagesFrom(mostRecentCachedTimestamp, rootMessages, allMessages, channelName, followedIds, preserve, cb);
			});
		}
	}
}
