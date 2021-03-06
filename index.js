var crypto    = require('crypto')
var fs        = require('fs')
var os        = require('os')
var request   = require('request')
var tools     = require('openssl-cert-tools')
var url       = require('url')
var validator = require('validator')
var validateCertUri = require('./validate-cert-uri')


// constants
var TIMESTAMP_TOLERANCE = 150
var SIGNATURE_FORMAT = 'base64'


function md5(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

function getCert (cert_url, callback) {
  var tmpdir = '/tmp' // os.tmpdir()
  var cert_filepath = tmpdir + '/' + md5(cert_url) + '.pem'

  fs.stat(cert_filepath, function(er, stat) {
    var cert_uri, result
    if (stat) {
      return fs.readFile(cert_filepath, 'utf8', callback)
    }

    cert_uri = url.parse(cert_url)
    result = validateCertUri(cert_uri)
    if (result !== true) {
      return callback(result)
    }

    fetchCert(cert_uri, function(er, pem_cert) {
      if (er) {
        return callback(er)
      }

      validateCert(pem_cert, function(er) {
        if (er) {
          return callback(er)
        }
        fs.writeFile(cert_filepath, pem_cert, 'utf8', function(er) {
          callback(er, pem_cert)
        })
      })
    })
  })
}


function fetchCert(uri, callback) {
  var cert_url
  cert_url = "https://" + uri.host + ":" + (uri.port || '') + "/" + uri.path
  request.get(cert_url, function(er, response, body) {
    if (body) {
      callback(null, body)
    } else {
      callback("Failed to download certificate at: " + cert_url + ". Response code: " + response.code + ", error: " + body)
    }
  })
}


function validateCert(pem_cert, callback) {
  return tools.getCertificateInfo(pem_cert, function(er, info) {
    if (er) {
      return callback(er)
    }

    // check that the domain echo-api.amazon.com is present in the Subject
    // Alternative Names (SANs) section of the signing certificate
    if (info.subject.CN.indexOf('echo-api.amazon.com') === -1) {
      return callback('subjectAltName Check Failed')
    }

    // check that the signing certificate has not expired (examine both the Not
    // Before and Not After dates)
    if (info.remainingDays < 1) {
      return callback('certificate expiration check failed')
    }
    callback()
  })
}


// returns true if the signature for the request body is valid, false otherwise
function validateSignature(pem_cert, signature, requestBody) {
  var verifier
  verifier = crypto.createVerify('RSA-SHA1')
  verifier.update(requestBody)
  return verifier.verify(pem_cert, signature, SIGNATURE_FORMAT)
}


// determine if a timestamp is valid for a given request with a tolerance of
// TIMESTAMP_TOLERANCE seconds
// returns null if valid, or an error string otherwise
function validateTimestamp(requestBody) {
  var d, e, error, now, oldestTime, request_json
  request_json = null
  try {
    request_json = JSON.parse(requestBody)
  } catch (error) {
    e = error
    return 'request body invalid json'
  }
  if (!(request_json.request && request_json.request.timestamp)) {
    return 'Timestamp field not present in request'
  }
  d = new Date(request_json.request.timestamp)
  now = new Date()
  oldestTime = now.getTime() - (TIMESTAMP_TOLERANCE * 1000)
  if (d.getTime() < oldestTime) {
    return "Request is from more than " + TIMESTAMP_TOLERANCE + " seconds ago"
  }
  return null
}


// certificate validator express middleware for amazon echo
module.exports = function verifier(cert_url, signature, requestBody, callback) {
  var er
  if (cert_url == null) {
    cert_url = ''
  }
  if (signature == null) {
    signature = ''
  }
  if (requestBody == null) {
    requestBody = ''
  }
  if (callback == null) {
    callback = function() { }
  }
  if (!validator.isBase64(signature)) {
    return callback('signature is not base64 encoded')
  }
  er = validateTimestamp(requestBody)

  if (er) {
    return callback(er)
  }
  
  getCert(cert_url, function(er, pem_cert) {
    var success
    if (er) {
      return callback(er)
    }
    success = validateSignature(pem_cert, signature, requestBody)
    if (success !== true) {
      return callback('certificate verification failed')
    }
    callback()
  })
}
