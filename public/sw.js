// Minimal Web Push service worker for Skopos alerts (price/polymarket/onchain
// watchers). No caching/offline behavior — this worker exists solely to
// receive push events while the app isn't in the foreground.

self.addEventListener("push", (event) => {
  let payload = { title: "Skopos", body: "You have a new alert." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // fall back to the default payload above
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/apple-touch-icon.png",
      data: { url: payload.url || "https://www.tryskopos.xyz/app" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "https://www.tryskopos.xyz/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
