// All credit to https://github.com/pull-stream/pull-many/blob/master/index.js
// Edits have been made to distinguish the original stream that each object came from,
// and to be able to end each stream independently

module.exports = function (ary) {

  var capped = !!ary
  var inputs = (ary || []).map(create), i = 0, abort, cb

  function create (stream) {
    return {ready: false, reading: false, ended: false, read: stream, data: null}
  }

  function check () {
    if(!cb) return
    clean()
    var l = inputs.length
    var _cb = cb
    if(l === 0 && (abort || capped)) {
      cb = null; _cb(abort ||  true)
      return
    }

    //scan the inputs to check whether there is one we can use.
    for(var j = 0; j < l; j++) {
      var current = inputs[(i + j) % l]
      if(current.ready && !current.ended) {
        var data = { // [EDIT] keep track of which exact source the data came from
		data: current.data,
		source: current.read.streamName
	}
        current.ready = false
        current.data = null
        i ++; cb = null
        return _cb(null, data)
      }
    }
  }

  function clean () {
    var l = inputs.length
    //iterate backwards so that we can remove items.
    while(l--) {
      if(inputs[l].ended)
        inputs.splice(l, 1)
    }
  }

  function next () {
    var l = inputs.length
    while(l--)
      (function (current) {
        //read the next item if we aren't already
        if(l > inputs.length) throw new Error('this should never happen')
        if(current.reading || current.ended || current.ready) return
        current.reading = true
        var sync = true
        current.read(abort, function next (end, data) {
          current.data = data
          current.ready = true
          current.reading = false

          if(end === true || abort) {
          	current.ended = true
          	if(current.read.streamName) {
	          	var timestamp = new Date();
			console.log("[pull-many-v2] [" + timestamp.toISOString() + "] " +  "reached the end of stream " + current.read.streamName);
          	}
          }
          else if(end) abort = current.ended = end
          //check whether we need to abort this stream.
          if(abort && !end) current.read(abort, next)
          if(!sync) check()
        })
        sync = false
      })(inputs[l])

    //scan the feed
    check()
  }

  function read (_abort, _cb) {
    abort = abort || _abort; cb = _cb; next()
  }

  read.add = function (stream) {
    if(!stream) {
      //the stream will now end when all the streams end.
      capped = true
      //we just changed state, so we may need to cb
      return next()
    }
    inputs.push(create(stream))
    next()
  }

  read.cap = function (err) {
    read.add(null)
  }
  
  read.inputs = inputs

  return read
}
