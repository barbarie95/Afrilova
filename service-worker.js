const CACHE_NAME = "afrilova-v1";

const APP_FILES = [
"./",
"./index.html",
"./explorer.html",
"./messagerie.html",
"./profil.html",
"./voir-profil.html"
];

self.addEventListener("install", (event) => {
event.waitUntil(
caches.open(CACHE_NAME).then((cache) =>
cache.addAll(APP_FILES)
)
);

self.skipWaiting();
});

self.addEventListener("activate", (event) => {
event.waitUntil(
caches.keys().then((keys) =>
Promise.all(
keys
.filter((key) => key !== CACHE_NAME)
.map((key) => caches.delete(key))
)
)
);

self.clients.claim();
});

self.addEventListener("fetch", (event) => {
const request = event.request;
const url = new URL(request.url);

if (
request.method !== "GET" ||
url.origin !== self.location.origin
) {
return;
}

event.respondWith(
fetch(request).catch(async () => {
const cached = await caches.match(request);
return cached || (
request.mode === "navigate"
? caches.match("./index.html")
: Response.error()
);
})
);
});
