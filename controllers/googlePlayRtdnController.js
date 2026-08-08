const {
  GooglePlayRtdnError,
  toPublicError,
  ingestGooglePlayNotification,
} = require('../services/googlePlayRtdnService');
const {
  GooglePubSubAuthError,
  GooglePubSubConfigurationError,
} = require('../services/googlePubSubPushAuthenticator');

async function handleGooglePlayRtdnNotification(req, res) {
  try {
    const contentTypeOk = req && typeof req.is === 'function' ? req.is('application/json') : false;
    if (!contentTypeOk) {
      return res.status(400).json(toPublicError());
    }

    if (!req || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json(toPublicError());
    }

    await ingestGooglePlayNotification({
      authorizationHeader: req && typeof req.get === 'function' ? req.get('authorization') : (req && req.headers ? req.headers.authorization : undefined),
      body: req.body,
      now: new Date(),
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof GooglePubSubAuthError) {
      return res.status(error.httpStatus || 403).json(toPublicError());
    }

    if (error instanceof GooglePubSubConfigurationError) {
      return res.status(500).json(toPublicError());
    }

    if (error instanceof GooglePlayRtdnError) {
      return res.status(error.httpStatus || 400).json(toPublicError());
    }

    return res.status(500).json(toPublicError());
  }
}

module.exports = {
  handleGooglePlayRtdnNotification,
};