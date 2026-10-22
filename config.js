/* ==========================================================================
   1. CONFIG.JS - FIREBASE CONFIGURATIE & GEDEELDE CONSTANTEN
   ========================================================================== */

var firebaseConfig = {
    apiKey: "AIzaSyDHNhlTRR0yr-6d_wOkmld1cInPLlxVM2o",
    authDomain: "jotihunt-amalgama.firebaseapp.com",
    databaseURL: "https://jotihunt-amalgama-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "jotihunt-amalgama",
    storageBucket: "jotihunt-amalgama.firebasestorage.app",
    messagingSenderId: "718674003357",
    appId: "1:718674003357:web:83b77c3334b9ea010e5b74",
    measurementId: "G-YBXKZPR30J"
};

firebase.initializeApp(firebaseConfig);
var db = firebase.database();

/* --- AUTOMATISCH ANONIEM INLOGGEN & WACHT-VANGNET --- */
var authReadyPromise = new Promise(function(resolve) {
    var unsubscribe = firebase.auth().onAuthStateChanged(function(user) {
        if (user) {
            unsubscribe();
            resolve(user);
        }
    });
});

firebase.auth().signInAnonymously().catch(function(error) {
    console.error("Fout bij anoniem inloggen Firebase:", error);
});

// Zorg dat alle lees- en schrijfacties automatisch wachten tot de anonieme sessie klaar is
(function() {
    var RefProto = firebase.database.Reference.prototype;

    var origOn = RefProto.on;
    RefProto.on = function(eventType, callback, cancelCallbackOrContext, context) {
        var self = this;
        authReadyPromise.then(function() {
            origOn.call(self, eventType, callback, cancelCallbackOrContext, context);
        });
        return callback;
    };

    var origOnce = RefProto.once;
    RefProto.once = function(eventType, successCallback, failureCallbackOrContext, context) {
        var self = this;
        return authReadyPromise.then(function() {
            return origOnce.call(self, eventType, successCallback, failureCallbackOrContext, context);
        });
    };

    ['set', 'update', 'remove'].forEach(function(method) {
        var origMethod = RefProto[method];
        RefProto[method] = function() {
            var self = this;
            var args = arguments;
            return authReadyPromise.then(function() {
                return origMethod.apply(self, args);
            });
        };
    });
})();

/* Globale applicatie-variabelen */
var isAdmin = false;
var currentUserName = "";
var currentUserId = "";

var targetAreas = ["Alpha", "Bravo", "Delta", "Foxtrot", "Golf", "Hotel", "Oscar"];
var areaColors = {
    "Alpha": "#e74c3c",
    "Bravo": "#f1c40f",
    "Delta": "#2ecc71",
    "Foxtrot": "#3498db",
    "Golf": "#ff69b4",
    "Hotel": "#e67e22",
    "Oscar": "#003399"
};

/* Vaste regenboogvolgorde voor de 6 Telegram Vossenstatussen */
var foxStatusOrder = ["rood", "oranje", "geel", "groen", "blauw", "grijs"];

/* Kleuren en labels voor de 6 Telegram Vossenstatussen (gesorteerd op regenboogvolgorde) */
var foxStatusConfig = {
    "rood":   { label: "Rood",   bg: "#e74c3c", border: "#c0392b", text: "#ffffff" },
    "oranje": { label: "Oranje", bg: "#e67e22", border: "#d35400", text: "#ffffff" },
    "geel":   { label: "Geel",   bg: "#f1c40f", border: "#d4ac0d", text: "#1a252f" },
    "groen":  { label: "Groen",  bg: "#2ecc71", border: "#27ae60", text: "#ffffff" },
    "blauw":  { label: "Blauw",  bg: "#3498db", border: "#2980b9", text: "#ffffff" },
    "grijs":  { label: "Grijs",  bg: "#7f8c8d", border: "#636e72", text: "#ffffff" }
};

/* Gedeelde state voor Vossenstatussen en zichtbaarheidsfilters */
var currentFoxStatuses = {};
var visibleFoxStatusColors = {
    "rood": true,
    "oranje": true,
    "geel": true,
    "groen": true,
    "blauw": true,
    "grijs": true
};

/* Gedeelde state voor Firebase Authenticatie-instellingen */
var firebaseAuthConfig = {
    adminPassword: null,
    userPassword: null,
    userSessionVersion: 1,
    loaded: false
};

/* Amalgama Clubgebouw Coördinaten */
var amalgamaLat = 51.83915;
var amalgamaLng = 5.78562;
var radiusMeters = 450;

/* Gedeelde data-opslag voor kaartweergave */
var allLocations = [];
var houseVisitedStatus = {};
var latestKnownAreaPoints = {};

/* Hulpfunctie: Vertaalt elke ruwe status (green, red, orange, grey, yellow, blue, etc.) naar 1 van de 6 sleutels */
function normalizeFoxStatusKey(rawStatus) {
    var s = String(rawStatus || "").toLowerCase().trim();
    if (s.includes("green") || s.includes("groen") || s.includes("vrij") || s.includes("actief")) return "groen";
    if (s.includes("red") || s.includes("rood") || s.includes("inactief") || s.includes("gevangen")) return "rood";
    if (s.includes("orange") || s.includes("oranje")) return "oranje";
    if (s.includes("yellow") || s.includes("geel")) return "geel";
    if (s.includes("blue") || s.includes("blauw")) return "blauw";
    if (s.includes("grey") || s.includes("gray") || s.includes("grijs")) return "grijs";
    return "grijs";
}

/* Hulpfunctie: Hemelsbrede afstand in km (voor navigatie-afstand in popups en snelheidsberekening) */
function getDistanceKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

window.navigateToAreaPoint = function(lat, lng) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
};