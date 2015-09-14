var util = require('util')

var EventEmitter = require('eventemitter3').EventEmitter
var debug = require('debug')('vnc:connection')

var PixelFormat = require('./pixelformat')

function VncConnection(conn) {
  this._bound = {
    _readableListener: this._readableListener.bind(this)
  }

  this._buffer = null
  this._state = 0
  this._changeState(VncConnection.STATE_NEED_CLIENT_VERSION)

  this._serverVersion = VncConnection.V3_008
  this._serverSupportedSecurity = [VncConnection.SECURITY_NONE]
  this._serverWidth = 800
  this._serverHeight = 600
  this._serverPixelFormat = new PixelFormat({
    bitsPerPixel: 32
  , depth: 24
  , bigEndianFlag: 1
  , trueColorFlag: 1
  , redMax: 255
  , greenMax: 255
  , blueMax: 255
  , redShift: 16
  , greenShift: 8
  , blueShift: 0
  })
  this._serverName = 'stf'

  this._clientVersion = null
  this._clientShare = false
  this._clientWidth = this._serverWidth
  this._clientHeight = this._serverHeight
  this._clientPixelFormat = this._serverPixelFormat
  this._clientEncodingCount = 0
  this._clientEncodings = []
  this._clientCutTextLength = 0

  this.conn = conn
    .on('readable', this._bound._readableListener)

  this._writeServerVersion()
  this._read()
}

util.inherits(VncConnection, EventEmitter)

VncConnection.V3_003 = 3003
VncConnection.V3_007 = 3007
VncConnection.V3_008 = 3008

VncConnection.SECURITY_NONE = 1
VncConnection.SECURITY_VNC = 2

VncConnection.SECURITYRESULT_OK = 0
VncConnection.SECURITYRESULT_FAIL = 1

VncConnection.CLIENT_MESSAGE_SETPIXELFORMAT = 0
VncConnection.CLIENT_MESSAGE_SETENCODINGS = 2
VncConnection.CLIENT_MESSAGE_FBUPDATEREQUEST = 3
VncConnection.CLIENT_MESSAGE_KEYEVENT = 4
VncConnection.CLIENT_MESSAGE_POINTEREVENT = 5
VncConnection.CLIENT_MESSAGE_CLIENTCUTTEXT = 6

var StateReverse = Object.create(null), State = {
  STATE_NEED_CLIENT_VERSION: 10
, STATE_NEED_CLIENT_SECURITY: 20
, STATE_NEED_CLIENT_INIT: 30
, STATE_NEED_CLIENT_MESSAGE: 40
, STATE_NEED_CLIENT_MESSAGE_SETPIXELFORMAT: 50
, STATE_NEED_CLIENT_MESSAGE_SETENCODINGS: 60
, STATE_NEED_CLIENT_MESSAGE_SETENCODINGS_VALUE: 61
, STATE_NEED_CLIENT_MESSAGE_FBUPDATEREQUEST: 70
, STATE_NEED_CLIENT_MESSAGE_KEYEVENT: 80
, STATE_NEED_CLIENT_MESSAGE_POINTEREVENT: 90
, STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT: 100
, STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT_VALUE: 101
}

Object.keys(State).map(function(name) {
  VncConnection[name] = State[name]
  StateReverse[State[name]] = name
})

VncConnection.prototype._writeServerVersion = function() {
  // Yes, we could just format the string instead. Didn't feel like it.
  switch (this._serverVersion) {
  case VncConnection.V3_003:
    this._write(new Buffer('RFB 003.003\n'))
    break
  case VncConnection.V3_007:
    this._write(new Buffer('RFB 003.007\n'))
    break
  case VncConnection.V3_008:
    this._write(new Buffer('RFB 003.008\n'))
    break
  }
}

VncConnection.prototype._writeSupportedSecurity = function() {
  var chunk = new Buffer(1 + this._serverSupportedSecurity.length)

  chunk[0] = this._serverSupportedSecurity.length
  this._serverSupportedSecurity.forEach(function(security, i) {
    chunk[1 + i] = security
  })

  this._write(chunk)
}

VncConnection.prototype._writeSelectedSecurity = function() {
  var chunk = new Buffer(4)
  chunk.writeUInt32BE(VncConnection.SECURITY_NONE, 0)
  this._write(chunk)
}

VncConnection.prototype._writeSecurityResult = function(result, reason) {
  var chunk
  switch (result) {
  case VncConnection.SECURITYRESULT_OK:
    chunk = new Buffer(4)
    chunk.writeUInt32BE(result, 0)
    this._write(chunk)
    break
  case VncConnection.SECURITYRESULT_FAIL:
    chunk = new Buffer(4 + 4 + reason.length)
    chunk.writeUInt32BE(result, 0)
    chunk.writeUInt32BE(reason.length, 4)
    chunk.write(reason, 8, reason.length)
    this._write(chunk)
    break
  }
}

VncConnection.prototype._writeServerInit = function() {
  var chunk = new Buffer(2 + 2 + 16 + 4 + this._serverName.length)
  chunk.writeUInt16BE(this._serverWidth, 0)
  chunk.writeUInt16BE(this._serverHeight, 2)
  chunk[4] = this._serverPixelFormat.bitsPerPixel
  chunk[5] = this._serverPixelFormat.depth
  chunk[6] = this._serverPixelFormat.bigEndianFlag
  chunk[7] = this._serverPixelFormat.trueColorFlag
  chunk.writeUInt16BE(this._serverPixelFormat.redMax, 8)
  chunk.writeUInt16BE(this._serverPixelFormat.greenMax, 10)
  chunk.writeUInt16BE(this._serverPixelFormat.blueMax, 12)
  chunk[14] = this._serverPixelFormat.redShift
  chunk[15] = this._serverPixelFormat.greenShift
  chunk[16] = this._serverPixelFormat.blueShift
  chunk[17] = 0 // padding
  chunk[18] = 0 // padding
  chunk[19] = 0 // padding
  chunk.writeUInt32BE(this._serverName.length, 20)
  chunk.write(this._serverName, 24, this._serverName.length)
  this._write(chunk)
}

VncConnection.prototype._readableListener = function() {
  this._read()
}

VncConnection.prototype._read = function() {
  var chunk, lo, hi
  while (this._append(this.conn.read())) {
    do {
      debug('state', StateReverse[this._state])
      switch (this._state) {
      case VncConnection.STATE_NEED_CLIENT_VERSION:
        if ((chunk = this._consume(12))) {
          this._clientVersion = this._parseVersion(chunk)
          debug('client version', this._clientVersion)
          this._writeSupportedSecurity()
          this._changeState(VncConnection.STATE_NEED_CLIENT_SECURITY)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_SECURITY:
        if ((chunk = this._consume(1))) {
          this._clientSecurity = this._parseSecurity(chunk)
          debug('client security', this._clientSecurity)
          this._writeSecurityResult(VncConnection.SECURITYRESULT_OK)
          this._changeState(VncConnection.STATE_NEED_CLIENT_INIT)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_INIT:
        if ((chunk = this._consume(1))) {
          this._clientShare = chunk[0]
          debug('client shareFlag', this._clientShare)
          this._writeServerInit()
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE:
        if ((chunk = this._consume(1))) {
          switch (chunk[0]) {
          case VncConnection.CLIENT_MESSAGE_SETPIXELFORMAT:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_SETPIXELFORMAT)
            break
          case VncConnection.CLIENT_MESSAGE_SETENCODINGS:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_SETENCODINGS)
            break
          case VncConnection.CLIENT_MESSAGE_FBUPDATEREQUEST:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_FBUPDATEREQUEST)
            break
          case VncConnection.CLIENT_MESSAGE_KEYEVENT:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_KEYEVENT)
            break
          case VncConnection.CLIENT_MESSAGE_POINTEREVENT:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_POINTEREVENT)
            break
          case VncConnection.CLIENT_MESSAGE_CLIENTCUTTEXT:
            this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT)
            break
          default:
            throw new Error(util.format('Unsupported message type %d', chunk[0]))
          }
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_SETPIXELFORMAT:
        if ((chunk = this._consume(19))) {
          // [0b, 3b) padding
          this._clientPixelFormat = new PixelFormat({
            bitsPerPixel: chunk[3]
          , depth: chunk[4]
          , bigEndianFlag: chunk[5]
          , trueColorFlag: chunk[6]
          , redMax: chunk.readUInt16BE(7, true)
          , greenMax: chunk.readUInt16BE(9, true)
          , blueMax: chunk.readUInt16BE(11, true)
          , redShift: chunk[13]
          , greenShift: chunk[14]
          , blueShift: chunk[15]
          })
          // [16b, 19b) padding
          debug('client pixel format', this._clientPixelFormat)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_SETENCODINGS:
        if ((chunk = this._consume(3))) {
          // [0b, 1b) padding
          this._clientEncodingCount = chunk.readUInt16BE(1, true)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_SETENCODINGS_VALUE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_SETENCODINGS_VALUE:
        lo = 0
        hi = 4 * this._clientEncodingCount
        if ((chunk = this._consume(hi))) {
          this._clientEncodings = []
          while (lo < hi) {
            this._clientEncodings.push(chunk.readInt32BE(lo, true))
            lo += 4
          }
          debug('client encodings', this._clientEncodings)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_FBUPDATEREQUEST:
        if ((chunk = this._consume(9))) {
          // incremental = chunk[0]
          // xPosition = chunk.readUInt16BE(1, true)
          // yPosition = chunk.readUInt16BE(3, true)
          // width = chunk.readUInt16BE(5, true)
          // height = chunk.readUInt16BE(7, true)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_KEYEVENT:
        if ((chunk = this._consume(7))) {
          // downFlag = chunk[0]
          // [1b, 3b) padding
          // key = chunk.readUInt32BE(3, true)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_POINTEREVENT:
        if ((chunk = this._consume(5))) {
          // buttonMask = chunk[0]
          // xPosition = chunk.readUInt16BE(1, true)
          // yPosition = chunk.readUInt16BE(3, true)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT:
        if ((chunk = this._consume(7))) {
          // [0b, 3b) padding
          this._clientCutTextLength = chunk.readUInt32BE(3)
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT_VALUE)
        }
        break
      case VncConnection.STATE_NEED_CLIENT_MESSAGE_CLIENTCUTTEXT_VALUE:
        if ((chunk = this._consume(this._clientCutTextLength))) {
          // value = chunk
          this._changeState(VncConnection.STATE_NEED_CLIENT_MESSAGE)
        }
        break
      default:
        throw new Error(util.format('Impossible state %d', this._state))
      }
    }
    while (chunk)
  }
}

VncConnection.prototype._parseVersion = function(chunk) {
  if (chunk.equals(new Buffer('RFB 003.008\n'))) {
    return VncConnection.V3_008
  }

  if (chunk.equals(new Buffer('RFB 003.007\n'))) {
    return VncConnection.V3_007
  }

  if (chunk.equals(new Buffer('RFB 003.003\n'))) {
    return VncConnection.V3_003
  }

  throw new Error('Unsupported version')
}

VncConnection.prototype._parseSecurity = function(chunk) {
  switch (chunk[0]) {
  case VncConnection.SECURITY_NONE:
  case VncConnection.SECURITY_VNC:
    return chunk[0]
  default:
    throw new Error('Unsupported security type')
  }
}

VncConnection.prototype._changeState = function(state) {
  this._state = state
}

VncConnection.prototype._append = function(chunk) {
  if (!chunk) {
    return false
  }

  debug('in', chunk)

  if (this._buffer) {
    this._buffer = Buffer.concat(
      [this._buffer, chunk], this._buffer.length + chunk.length)
  }
  else {
    this._buffer = chunk
  }

  return true
}

VncConnection.prototype._consume = function(n) {
  var chunk

  if (!this._buffer) {
    return null
  }

  if (n < this._buffer.length) {
    chunk = this._buffer.slice(0, n)
    this._buffer = this._buffer.slice(n)
    return chunk
  }

  if (n === this._buffer.length) {
    chunk = this._buffer
    this._buffer = null
    return chunk
  }

  return null
}

VncConnection.prototype._write = function(chunk) {
  debug('out', chunk)
  this.conn.write(chunk)
}

module.exports = VncConnection