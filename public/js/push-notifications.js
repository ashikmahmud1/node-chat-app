'use strict';

const PUSH_SUBSCRIPTION_URL = '/api/push/subscription';

async function notificationRequest(url, method = 'GET', data) {
  const response = await fetch(url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 204) return;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not update notifications.');
  return result;
}

function resolvePushNotification(id) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
    return Promise.reject(new Error('This notification is no longer available.'));
  }
  return notificationRequest('/api/push/target/' + id);
}

async function setupPushNotifications() {
  const button = document.getElementById('toggle-push-notifications');
  const status = document.getElementById('push-notifications-status');
  if (!window.isSecureContext || !('serviceWorker' in navigator) ||
      !('PushManager' in window) || !('Notification' in window)) {
    status.textContent = 'Push notifications are unavailable in this browser.';
    return;
  }

  try {
    const [{ publicKey }] = await Promise.all([
      notificationRequest('/api/push'),
      navigator.serviceWorker.register('/service-worker.js'),
    ]);
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (byte) => byte.charCodeAt(0));
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const existingKey = new Uint8Array(subscription.options.applicationServerKey);
      if (existingKey.length !== key.length || existingKey.some((byte, index) => byte !== key[index])) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    let enabled = subscription && (await notificationRequest(PUSH_SUBSCRIPTION_URL, 'PATCH', {
      endpoint: subscription.endpoint,
    })).enabled;
    const render = (message) => {
      button.textContent = enabled ? 'Disable notifications' : 'Enable notifications';
      button.disabled = !enabled && Notification.permission === 'denied';
      status.textContent = message || (enabled ? 'Direct messages and incoming direct and group calls' :
        Notification.permission === 'denied' ? 'Allow notifications in your browser settings.' : '');
    };
    render();

    button.addEventListener('click', async () => {
      button.disabled = true;
      let message;
      try {
        if (enabled) {
          await notificationRequest(PUSH_SUBSCRIPTION_URL, 'DELETE', { endpoint: subscription.endpoint });
          enabled = false;
          await subscription.unsubscribe();
          subscription = null;
        } else {
          // The browser permission prompt must start in the click handler.
          subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          await notificationRequest(PUSH_SUBSCRIPTION_URL, 'PUT', subscription.toJSON());
          enabled = true;
        }
      } catch (error) {
        message = Notification.permission === 'denied' ? 'Allow notifications in your browser settings.' :
          error.name === 'Error' ? error.message : 'Could not update notifications. Try again.';
      }
      render(message);
    });
  } catch {
    status.textContent = 'Could not set up notifications. Reload to try again.';
  }
}
