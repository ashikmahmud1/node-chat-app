const config = require('../config');

class SlidingWindowRateLimiter {
  constructor({ windowMs = 60000, max = 100 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    // Map<key, { count, resetAt }>
    this.buckets = new Map();
  }

  consume(key) {
    const now = Date.now();
    const record = this.buckets.get(key);

    if (!record || now >= record.resetAt) {
      const nextRecord = { count: 1, resetAt: now + this.windowMs };
      this.buckets.set(key, nextRecord);
      return {
        allowed: true,
        remaining: Math.max(0, this.max - 1),
        resetAt: nextRecord.resetAt,
      };
    }

    record.count += 1;
    const allowed = record.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - record.count),
      resetAt: record.resetAt,
    };
  }

  remove(key) {
    this.buckets.delete(key);
  }
}

const createHttpRateLimiter = (options = {}) => {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: options.windowMs || config.limits.httpRateLimitWindowMs,
    max: options.max || config.limits.httpRateLimitMax,
  });

  return (req, res, next) => {
    // If headers have already been sent (e.g. from an aborted static file stream), bypass setting headers
    if (res.headersSent) {
      return next();
    }

    const clientKey = req.ip || (req.socket && req.socket.remoteAddress) || 'global';
    const result = limiter.consume(clientKey);

    res.setHeader('X-RateLimit-Limit', String(limiter.max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too many requests. Please slow down and try again shortly.',
      });
    }

    return next();
  };
};

module.exports = {
  SlidingWindowRateLimiter,
  createHttpRateLimiter,
};
