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

/* Amalgama Clubgebouw Coördinaten */
var amalgamaLat = 51.83915;
var amalgamaLng = 5.78562;
var radiusMeters = 450;

/* Gedeelde data-opslag voor kaartweergave */
var allLocations = [];
var houseVisitedStatus = {};
var latestKnownAreaPoints = {};
var lastCachedAreas = [];
var disabledBlinks = {};

/* Hulpfunctie: Hemelsbrede afstand in km (voor navigatie-afstand in popups) */
function getDistanceKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* Hulpfunctie: Vertaal ruwe API-status naar uniforme kleurcategorie */
function getNormalizedStatusCategory(rawStatus) {
    var s = String(rawStatus || '').toLowerCase().trim();
    if (s === 'inactief' || s === 'inactive' || s.includes('red') || s.includes('rood') || s.includes('gevangen') || s.includes('caught') || s === '0' || s === 'false') {
        return { key: 'rood', label: 'Rood (Inactief/Gevangen)' };
    } else if (s === 'actief' || s.includes('green') || s.includes('groen') || s === 'active' || s === 'field' || s === 'open' || s === 'vrij' || s === '1' || s === 'true') {
        return { key: 'groen', label: 'Groen (Actief)' };
    } else if (s.includes('rust') || s.includes('orange') || s.includes('oranje') || s.includes('yellow') || s.includes('geel') || s.includes('onderweg') || s === 'pause' || s === 'resting' || s === '2') {
        return { key: 'geel', label: 'Oranje/Geel (Rust)' };
    }
    return { key: 'grijs', label: 'Grijs (Onbekend)' };
}

function openJotihuntSite() { window.open('https://jotihunt.nl/', '_blank'); }
function dismissNotification(e) {
    e.stopPropagation();
    document.getElementById('notification-banner').style.display = 'none';
}
window.navigateToAreaPoint = function(lat, lng) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
};