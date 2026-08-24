// War of Lords — bundled mobile app shell. Talks directly to the SAME production backend the
// desktop site uses (REST + Socket.io) — nothing about game logic is reimplemented or cached
// locally here, only the presentation is native/mobile-focused. See W:\War of Lords\src\server.js
// / public\game.js for the authoritative behavior this mirrors.
(function () {
    'use strict';

    const API_BASE = 'https://waroflords.pl';
    const BUNDLE_VERSION_URL = API_BASE + '/mobile-app/version.json';

    // ---- Self-hosted OTA web-bundle updates (@capgo/capacitor-updater, autoUpdate:false in
    // capacitor.config.json) — lets every future change to this www/ folder ship instantly via the
    // "Sprawdź aktualizacje" button instead of rebuilding/reinstalling the whole APK again. Safety
    // net: if the newly-applied bundle never calls notifyAppReady() (e.g. it's broken), the plugin
    // automatically reverts to the last working bundle within ~10s — this call MUST run
    // unconditionally, on every single launch, or a perfectly fine bundle would roll itself back. ----
    const Updater = window.Capacitor?.Plugins?.CapacitorUpdater;
    if (Updater) Updater.notifyAppReady().catch(() => {});
    const UNIT_DEFS = [
        { id: 'archer', label: 'Włócznik' },
        { id: 'shield', label: 'Tarczownik' },
        { id: 'axe', label: 'Topornik' },
        { id: 'scout', label: 'Zwiadowca' },
        { id: 'cavalry', label: 'Jazda' },
        { id: 'ram', label: 'Taran' },
        { id: 'lord', label: 'Lord' }
    ];
    const UNIT_LABELS = Object.fromEntries(UNIT_DEFS.map((u) => [u.id, u.label]));

    // ---- Tiny persisted device id (mirrors public/fingerprint.js's purpose — a stable per-install
    // identifier for the multi-account guard — but canvas/WebGL fingerprinting is unreliable inside
    // a WebView, so this just persists a random id once instead). ----
    function getDeviceId() {
        let id = localStorage.getItem('wlb_mobile_device_id');
        if (!id) {
            id = 'mobile-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem('wlb_mobile_device_id', id);
        }
        return id;
    }

    let authToken = localStorage.getItem('authToken') || null;
    let socket = null;
    let gameState = null; // last received state (game:init / game:state)
    let myUserId = null;
    let myPlayerName = null;
    let selectedVillageId = null; // for Rozbudowa/Wojska tabs
    let attackTargetId = null; // village picked on Mapa tab, used by Wojska's attack form
    let activeTab = 'map'; // Mapa jest teraz pierwszym widokiem po wejściu do gry (Wioska usunięta)
    let currentRoomId = null;
    let currentRoom = null; // full room object (name/settings/playersCanAddBots) for the lobby screen
    let myProfile = null; // cached GET /api/auth/me response
    let currentMatchId = null; // set while waiting for mini-tournament match acceptance
    let roundFinishedShown = false; // guards showRoundResults() against showing twice for the same round
    let roundEndingInterval = null;
    let rankingMode = 'points'; // 'points' | 'kills' — mirrors desktop game.js's state.rankingMode
    let reportsMode = 'attack'; // 'attack' | 'defense' — mirrors desktop game.js's state.reportsMode
    let teamChatMessages = []; // team-mode only, populated via game:teamChatHistory/game:teamChatMessage

    function $(id) { return document.getElementById(id); }
    function showScreen(id) {
        document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
        $(id).classList.add('active');
    }
    function toast(msg) {
        const el = $('toast');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => el.classList.remove('show'), 2600);
    }
    function authHeaders() {
        return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken };
    }

    // ================= LOGIN =================
    $('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const identifier = $('loginIdentifier').value.trim();
        const password = $('loginPassword').value;
        $('loginError').textContent = '';
        try {
            const res = await fetch(API_BASE + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, password })
            });
            const result = await res.json();
            // A blocked account's real reason (multi-account detection, admin action) lives in
            // result.blockReason - result.error is just the generic 'user blocked' string, which
            // isn't useful to show the player on its own (mirrors index.html's blockedReasonText).
            if (!res.ok) { $('loginError').textContent = (result.blocked && result.blockReason) || result.error || 'Błąd logowania'; return; }
            authToken = result.token;
            localStorage.setItem('authToken', authToken);
            await fetchMyProfile();
            await resumeOrShowMenu();
        } catch (err) {
            $('loginError').textContent = 'Brak połączenia z serwerem.';
        }
    });

    $('btnLogout').addEventListener('click', () => {
        localStorage.removeItem('authToken');
        authToken = null;
        if (socket) { socket.disconnect(); socket = null; }
        gameState = null;
        showScreen('screen-login');
    });

    // Needed early: lobby:join and the multi-account guard need our own userId, but the login
    // response only returns {token, username} — not _id — so fetch it once via the existing
    // "who am I" endpoint right after obtaining a token.
    async function fetchMyProfile() {
        try {
            const res = await fetch(API_BASE + '/api/auth/me', { headers: authHeaders() });
            if (res.ok) {
                myProfile = await res.json();
                myUserId = myProfile._id;
            }
        } catch (err) { /* game:init will still set this once a round is joined */ }
    }

    // Guards the "resume an active round" flow so the user is never stuck staring at a spinner (or
    // whatever screen happened to be up) forever if game:join silently fails to produce a game:init
    // — e.g. the round ended a moment ago, a flaky mobile connection drops the join, or the server
    // hiccups. If game:init hasn't arrived within RESUME_TIMEOUT_MS, we give up and land on the menu
    // instead, where "Wróć do rozgrywki" lets the player retry by hand.
    let resumeTimeoutHandle = null;
    const RESUME_TIMEOUT_MS = 10000;
    function clearResumeTimeout() {
        if (resumeTimeoutHandle) { clearTimeout(resumeTimeoutHandle); resumeTimeoutHandle = null; }
    }

    // After login (or on cold app start with a saved token): resume an in-progress round if one
    // exists (GET /api/game/state with no roundId — src/server.js's existing "resume banner" query),
    // otherwise land on the main menu. Exactly the same rule the desktop site's resume banner uses,
    // just decides which screen to show instead of rendering a banner. Also reused directly by the
    // manual "Wróć do rozgrywki" button (showNoActiveToast=true there, so a deliberate click that
    // finds nothing gets an explicit "no active round" message instead of just silently landing on
    // the menu, which would look like nothing happened).
    async function attemptResume(showNoActiveToast) {
        try {
            const res = await fetch(API_BASE + '/api/game/state', { headers: authHeaders() });
            if (res.status === 200) {
                const data = await res.json();
                showScreen('screen-resuming');
                clearResumeTimeout();
                resumeTimeoutHandle = setTimeout(() => {
                    resumeTimeoutHandle = null;
                    showMenuScreen();
                    toast('Nie udało się wrócić do rozgrywki. Spróbuj ponownie.');
                }, RESUME_TIMEOUT_MS);
                connectSocketAndJoinRound(data.state.roundId);
                return;
            }
        } catch (err) { /* fall through to main menu */ }
        showMenuScreen();
        if (showNoActiveToast) toast('Brak aktywnej rozgrywki.');
    }
    async function resumeOrShowMenu() {
        await attemptResume(false);
    }
    $('btnReturnToGame').addEventListener('click', () => attemptResume(true));
    $('btnCancelResume').addEventListener('click', () => {
        clearResumeTimeout();
        showMenuScreen();
    });

    // ================= MENU GŁÓWNE =================
    // Baseline version baked into this APK build — every OTA update bumps localStorage's copy past
    // this, so the label always reflects whatever www/ content is actually currently running.
    if (!localStorage.getItem('wlb_bundle_version')) localStorage.setItem('wlb_bundle_version', '1.0.0');

    function showMenuScreen() {
        showScreen('screen-menu');
        $('currentVersionLabel').textContent = localStorage.getItem('wlb_bundle_version');
    }

    document.querySelectorAll('[data-nav]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const dest = btn.dataset.nav;
            if (dest === 'menu') showMenuScreen();
            else if (dest === 'rooms') showRoomsScreen();
            else if (dest === 'tournaments') showTournamentsScreen();
            else if (dest === 'shop') showShopScreen();
            else if (dest === 'ranking') showRankingScreen();
            else if (dest === 'profile') showProfileScreen();
        });
    });

    // ================= AKTUALIZACJE (OTA) =================
    $('btnCheckUpdate').addEventListener('click', checkForUpdate);

    async function checkForUpdate() {
        const statusEl = $('updateStatus');
        if (!Updater) { statusEl.textContent = 'Aktualizacje niedostępne w tej wersji przeglądarki.'; return; }
        statusEl.textContent = 'Sprawdzam aktualizacje...';
        try {
            const res = await fetch(BUNDLE_VERSION_URL, { cache: 'no-store' });
            if (!res.ok) { statusEl.textContent = 'Nie udało się sprawdzić aktualizacji.'; return; }
            const info = await res.json(); // { version, url }
            const current = localStorage.getItem('wlb_bundle_version') || '0';
            if (info.version === current) { statusEl.textContent = 'Masz już najnowszą wersję (' + current + ').'; return; }
            statusEl.textContent = 'Pobieram nową wersję ' + info.version + '...';
            const bundle = await Updater.download({ version: info.version, url: info.url });
            statusEl.textContent = 'Instaluję...';
            localStorage.setItem('wlb_bundle_version', info.version);
            await Updater.set(bundle);
            // set() reloads the WebView onto the new bundle — this script's own execution ends here.
        } catch (err) {
            statusEl.textContent = 'Błąd aktualizacji: ' + (err.message || err);
        }
    }

    // ================= ROOMS =================
    async function showRoomsScreen() {
        showScreen('screen-rooms');
        $('roomsList').innerHTML = '<p class="hint-text">Ładowanie pokoi...</p>';
        try {
            const res = await fetch(API_BASE + '/api/rooms', { headers: authHeaders() });
            const data = await res.json();
            // Pokoje Bitewne = zwykłe rundy; turniejowe/mini-turniejowe pokoje mają własny ekran
            // (Turnieje), więc są tu celowo pomijane.
            const rooms = (Array.isArray(data) ? data : (data.rooms || [])).filter((r) => !r.isMiniTournament && !r.isTournament);
            if (!rooms.length) { $('roomsList').innerHTML = '<p class="hint-text">Brak dostępnych pokoi.</p>'; return; }
            $('roomsList').innerHTML = '';
            rooms.forEach((room) => {
                const card = document.createElement('div');
                card.className = 'room-card';
                const name = room.nazwaPokoju || room.roomName || 'Pokój';
                const count = room.waitingCount ?? (room.waitingPlayers ? room.waitingPlayers.length : 0);
                const max = room.maxGraczy ?? room.maxPlayers ?? 10;
                const durationMin = Math.round((room.ustawienia?.dlugoscRundySekundy || 3600) / 60);
                const modeText = room.roomType === 'team' ? 'Tryb drużynowy' : room.roomType === 'percentage' ? 'Tryb procentowy' : 'Tryb klasyczny';
                const botsText = room.playersCanAddBots ? 'boty dozwolone' : 'bez botów';
                card.innerHTML = `
                    <div>
                        <h3>${name}</h3>
                        <div class="stat-chips">
                            <span class="stat-chip">⏱️ <strong>${durationMin} min</strong></span>
                            <span class="stat-chip">⚡ <strong>${room.speedFactor ?? 1}x</strong></span>
                            <span class="stat-chip">👥 <strong>${count}/${max}</strong></span>
                        </div>
                        <p class="room-card-desc">${modeText} · ${botsText}</p>
                    </div>
                    <button>Dołącz</button>`;
                card.querySelector('button').addEventListener('click', () => joinRoom(room));
                $('roomsList').appendChild(card);
            });
        } catch (err) {
            $('roomsList').innerHTML = '<p class="hint-text">Błąd ładowania pokoi.</p>';
        }
    }

    async function joinRoom(room) {
        try {
            const res = await fetch(API_BASE + '/api/rooms/' + room._id + '/join', { method: 'POST', headers: authHeaders() });
            const result = await res.json();
            if (!res.ok) { toast(result.error || 'Nie udało się dołączyć.'); return; }
            currentRoomId = room._id;
            currentRoom = room;
            showLobbyScreen(room);
        } catch (err) {
            toast('Brak połączenia z serwerem.');
        }
    }

    // ================= TURNIEJE (uproszczone — sama możliwość wzięcia udziału) =================
    // Zakup biletów (turniejowego i do Mini-Turnieju) żyje wyłącznie w Sklepie (showShopScreen) -
    // ten ekran pokazuje TYLKO kafelki dostępnych pokoi Mini-Turniejowych, bez żadnego UI zakupowego,
    // żeby nie dublować tej samej funkcji w dwóch miejscach.
    async function showTournamentsScreen() {
        showScreen('screen-tournaments');
        const el = $('tournamentsContent');
        el.innerHTML = '<p class="hint-text">Ładowanie...</p>';
        try {
            const roomsRes = await fetch(API_BASE + '/api/rooms?miniTournament=1', { headers: authHeaders() });
            const roomsData = roomsRes.ok ? await roomsRes.json() : [];
            const miniRooms = Array.isArray(roomsData) ? roomsData : (roomsData.rooms || []);

            let html = '';
            if (miniRooms.length) {
                html += '<div id="miniTournamentTiles" class="rooms-list" style="overflow-y:visible;"></div>';
            } else {
                html += '<p class="hint-text">Brak aktywnych pokoi Mini-Turniejowych.</p>';
            }
            el.innerHTML = html;

            if (miniRooms.length) {
                const tilesEl = $('miniTournamentTiles');
                miniRooms.forEach((r) => {
                    const card = document.createElement('div');
                    card.className = 'room-card';
                    const name = r.nazwaPokoju || r.roomName || 'Mini-Turniej';
                    const count = r.waitingCount ?? (r.waitingPlayers ? r.waitingPlayers.length : 0);
                    const max = r.maxGraczy ?? r.maxPlayers ?? 10;
                    const durationMin = Math.round((r.ustawienia?.dlugoscRundySekundy || 3600) / 60);
                    const prizes = `${r.miniTournamentPrizes?.place1VPLN ?? 0}/${r.miniTournamentPrizes?.place2VPLN ?? 0}/${r.miniTournamentPrizes?.place3VPLN ?? 0} VPLN`;
                    // Bilet wymagany jest tylko wtedy gdy DANY pokój tego faktycznie wymaga
                    // (r.requiresMiniTournamentTicket) - wcześniej przycisk był blokowany dla KAŻDEGO
                    // pokoju bez biletu, nawet takich co go w ogóle nie wymagają.
                    const needsTicket = !!r.requiresMiniTournamentTicket;
                    const canSearch = !needsTicket || !!myProfile?.hasUnusedMiniTournamentTicket;
                    card.innerHTML = `
                        <div>
                            <h3>${name}</h3>
                            <div class="stat-chips">
                                <span class="stat-chip">⏱️ <strong>${durationMin} min</strong></span>
                                <span class="stat-chip">⚡ <strong>${r.speedFactor ?? 1}x</strong></span>
                                <span class="stat-chip">👥 <strong>${count}/${max}</strong></span>
                            </div>
                            <p class="room-card-desc">🏆 Nagrody: ${prizes}${needsTicket ? ' · wymaga biletu' : ''}</p>
                        </div>
                        <button ${canSearch ? '' : 'disabled'}>Szukaj gry</button>`;
                    card.querySelector('button').addEventListener('click', () => showMiniMatchmakingScreen(r));
                    tilesEl.appendChild(card);
                });
            }
        } catch (err) {
            el.innerHTML = '<p class="hint-text">Błąd ładowania turniejów.</p>';
        }
    }

    // ================= SKLEP =================
    async function showShopScreen() {
        showScreen('screen-shop');
        const el = $('shopContent');
        el.innerHTML = '<p class="hint-text">Ładowanie...</p>';
        try {
            const [ticketsRes, miniRes] = await Promise.all([
                fetch(API_BASE + '/api/settings/tournament-tickets', { headers: authHeaders() }),
                fetch(API_BASE + '/api/settings/mini-tournament-ticket-price', { headers: authHeaders() })
            ]);
            const tickets = ticketsRes.ok ? await ticketsRes.json() : {};
            const mini = miniRes.ok ? await miniRes.json() : {};
            el.innerHTML = `
                <div class="ticket-row">
                    <div class="ticket-card">
                        <div class="ticket-card-top">
                            <span class="ticket-icon">🎟️</span>
                            <h3>Bilet<br>Turniejowy</h3>
                        </div>
                        <div class="ticket-perforation"></div>
                        <div class="ticket-card-bottom">
                            <p class="row-sub">${tickets.ticketPricePLN ?? '?'} zł</p>
                            <p class="row-sub">pozostało ${tickets.remaining ?? '?'} / ${tickets.total ?? '?'}</p>
                            ${tickets.open === false ? '<p class="hint-text">Sprzedaż zamknięta.</p>' : buyBlockHtml('buyTournamentTicket', 'Kup')}
                        </div>
                    </div>
                    <div class="ticket-card">
                        <div class="ticket-card-top">
                            <span class="ticket-icon">🎫</span>
                            <h3>Bilet do<br>Mini-Turnieju</h3>
                        </div>
                        <div class="ticket-perforation"></div>
                        <div class="ticket-card-bottom">
                            <p class="row-sub">${mini.priceZl ?? '?'} zł</p>
                            <p class="row-sub">pozostało ${mini.remaining ?? '?'}</p>
                            ${buyBlockHtml('buyMiniTicket', 'Kup')}
                        </div>
                    </div>
                </div>`;
            wireBuyButtons(el, showShopScreen);
        } catch (err) {
            el.innerHTML = '<p class="hint-text">Błąd ładowania sklepu.</p>';
        }
    }

    // Compact inline consent-checkbox + buy button — mirrors the real purchase-consent requirement
    // (regulamin.html §5/§5a) without a full modal, since this is a simplified mobile pass. "Regulamin
    // zakupu" is a real, tappable link to the actual document (opened via openLegalDoc, same as the
    // footer/Profil links) - not just inert label text - so the player can actually read what
    // they're agreeing to before checking the box. It's a separate button INSIDE the label rather
    // than the label's own text, so tapping it opens the document instead of just toggling the
    // checkbox (a plain <label> would otherwise swallow the tap as "toggle").
    function buyBlockHtml(action, label) {
        return `<label class="row-sub consent-row" for="consent-${action}">
                <input type="checkbox" id="consent-${action}" data-consent="${action}">
                <span>Akceptuję <button type="button" class="legal-inline-link" data-legal="regulamin" onclick="event.preventDefault()">Regulamin zakupu</button></span>
            </label>
            <button class="row-action" data-buy="${action}" disabled>${label}</button>`;
    }
    function wireBuyButtons(el, refreshFn) {
        wireLegalLinks(el);
        el.querySelectorAll('[data-consent]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const btn = el.querySelector(`[data-buy="${cb.dataset.consent}"]`);
                if (btn) btn.disabled = !cb.checked;
            });
        });
        el.querySelectorAll('[data-buy]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.buy === 'buyTournamentTicket') purchaseTicket('tournament', refreshFn);
                else if (btn.dataset.buy === 'buyMiniTicket') purchaseTicket('mini', refreshFn);
            });
        });
    }

    // Real-money purchases always go through CashBill's own hosted payment page (never instant —
    // see src/server.js's /api/payments/tickets|mini-tickets/create) — opened in the SYSTEM browser
    // (Capacitor's Browser plugin), not this app's own WebView, since 3-D Secure bank pages can
    // refuse to run inside an embedded WebView and the CashBill return page lives on the live site
    // anyway, not inside this bundled app.
    async function purchaseTicket(kind, refreshFn) {
        const createUrl = kind === 'tournament' ? '/api/payments/tickets/create' : '/api/payments/mini-tickets/create';
        const body = kind === 'tournament' ? { quantity: 1, consentAccepted: true } : { consentAccepted: true };
        const statusUrlBase = kind === 'tournament' ? '/api/payments/tickets/' : '/api/payments/mini-tickets/';
        try {
            const res = await fetch(API_BASE + createUrl, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            const result = await res.json();
            if (!res.ok) { toast(result.error || 'Nie udało się rozpocząć zakupu.'); return; }
            const opener = window.Capacitor?.Plugins?.Browser;
            if (opener) opener.open({ url: result.redirectUrl }); else window.open(result.redirectUrl, '_blank');
            toast('Dokończ płatność w otwartej karcie przeglądarki...');
            pollOrderStatus(statusUrlBase + result.orderId + '/status', refreshFn);
        } catch (err) {
            toast('Brak połączenia z serwerem.');
        }
    }

    function pollOrderStatus(statusUrl, refreshFn, attemptsLeft = 40) {
        if (attemptsLeft <= 0) return;
        setTimeout(async () => {
            try {
                const res = await fetch(API_BASE + statusUrl, { headers: authHeaders() });
                const data = await res.json();
                if (data.status === 'paid') {
                    toast('✅ Płatność zaksięgowana!');
                    await fetchMyProfile();
                    if (refreshFn) refreshFn();
                    return;
                }
                if (data.status === 'failed') { toast('Płatność nieudana.'); return; }
                pollOrderStatus(statusUrl, refreshFn, attemptsLeft - 1);
            } catch (err) {
                pollOrderStatus(statusUrl, refreshFn, attemptsLeft - 1);
            }
        }, 3000);
    }

    // ================= RANKING =================
    async function showRankingScreen() {
        showScreen('screen-ranking');
        const el = $('rankingContent');
        el.innerHTML = '<p class="hint-text">Ładowanie...</p>';
        try {
            const res = await fetch(API_BASE + '/api/ranking');
            const ranking = await res.json();
            const medals = ['🥇', '🥈', '🥉'];
            el.innerHTML = ranking.map((r) => `
                <div class="row-item">
                    <div>
                        <span class="row-title">${medals[r.rank - 1] || r.rank + '.'} ${r.nick}</span>
                        <div class="row-sub">${r.sumaGier} gier · ${r.wygrane} wygranych</div>
                    </div>
                    <span class="row-title">${r.mmr}</span>
                </div>`).join('') || '<p class="hint-text">Brak danych rankingowych.</p>';
        } catch (err) {
            el.innerHTML = '<p class="hint-text">Błąd ładowania rankingu.</p>';
        }
    }

    // ================= PROFIL =================
    async function showProfileScreen() {
        showScreen('screen-profile');
        await fetchMyProfile();
        const el = $('profileContent');
        if (!myProfile) { el.innerHTML = '<p class="hint-text">Błąd ładowania profilu.</p>'; return; }
        el.innerHTML = `
            <div class="panel-card">
                <h3>${myProfile.username}</h3>
                <div class="row-item"><span class="row-title">Saldo VPLN</span><span>${myProfile.vplnBalance ?? 0}</span></div>
                <div class="row-item"><span class="row-title">Punkty Umiejętności</span><span>${myProfile.skillPoints ?? 0}</span></div>
                <div class="row-item"><span class="row-title">MMR Mini-Turniejów</span><span>${myProfile.tournamentMMR ?? 1000}</span></div>
                <div class="row-item"><span class="row-title">Rozegrane rundy</span><span>${myProfile.roundsPlayed ?? 0}</span></div>
                <div class="row-item"><span class="row-title">Wygrane rundy</span><span>${myProfile.roundsWon ?? 0}</span></div>
                <div class="row-item"><span class="row-title">Bilety Turniejowe</span><span>${myProfile.tournamentTickets ?? 0}</span></div>
                <div class="row-item"><span class="row-title">Bilet do Mini-Turnieju</span><span>${myProfile.hasUnusedMiniTournamentTicket ? 'Tak' : 'Brak'}</span></div>
            </div>
            <p class="hint-text">Wypłatę salda VPLN na konto bankowe zrealizujesz na razie w wersji przeglądarkowej (Profil → Wypłać VPLN).</p>
            <div class="panel-card">
                <h3>📜 Dokumenty prawne</h3>
                <div class="row-item"><span class="row-title">Regulamin Serwisu</span><button class="row-action" data-legal="regulamin">Otwórz</button></div>
                <div class="row-item"><span class="row-title">Polityka Prywatności</span><button class="row-action" data-legal="polityka">Otwórz</button></div>
                <div class="row-item"><span class="row-title">Zasady gry</span><button class="row-action" data-legal="zasady">Otwórz</button></div>
                <div class="row-item"><span class="row-title">Zasady Turnieju</span><button class="row-action" data-legal="zasady-turniej">Otwórz</button></div>
                <div class="row-item"><span class="row-title">Zasady Mini-Turniejów</span><button class="row-action" data-legal="zasady-mini-turniej">Otwórz</button></div>
            </div>`;
        wireLegalLinks(el);
    }

    // Regulamin/Polityka/Zasady zawsze otwierane z ZYWEJ strony (nie bundlowane w apce) - to samo
    // rozwiazanie co CashBill w purchaseTicket(): tresc prawna MUSI zawsze pokazywac AKTUALNA wersje,
    // bundlowana kopia moglaby sie zdezaktualizowac po zmianie regulaminu bez wymuszania aktualizacji
    // OTA. Otwierane w systemowej przegladarce (Capacitor Browser plugin), nie w WebView tej apki.
    const LEGAL_URLS = {
        regulamin: '/regulamin.html',
        polityka: '/polityka-prywatnosci.html',
        zasady: '/zasady.html',
        'zasady-turniej': '/zasady-turnieju.html',
        'zasady-mini-turniej': '/zasady-mini-turniej.html'
    };
    function openLegalDoc(key) {
        const path = LEGAL_URLS[key];
        if (!path) return;
        const url = API_BASE + path;
        const opener = window.Capacitor?.Plugins?.Browser;
        if (opener) opener.open({ url }); else window.open(url, '_blank');
    }
    function wireLegalLinks(container) {
        container.querySelectorAll('[data-legal]').forEach((btn) => {
            btn.addEventListener('click', () => openLegalDoc(btn.dataset.legal));
        });
    }
    wireLegalLinks(document.getElementById('screen-login'));
    // Stopka poza .screen (zawsze widoczna, na kazdym ekranie/podstronie/karcie gry) - patrz
    // #appFooter w index.html.
    wireLegalLinks(document.getElementById('appFooter'));

    // ================= WAITING ROOM (zwykłe pokoje ORAZ matchmaking w ciemno Mini-Turniejów) ======
    let isMiniWaiting = false;

    // Mini-Turnieje: blind matchmaking — no nicknames/stats visible until the whole group of 10
    // accepts (see the earlier-built joinMiniTournamentQueue/matchmaking:* flow in src/server.js).
    // The reveal after full acceptance arrives as an ordinary lobby:update_list, same as a normal
    // room — handled below by switching to screen-lobby the moment that event fires.
    // matchmaking:join is only a state-sync/rejoin event for someone ALREADY in the queue/
    // pendingMatches/waitingPlayers server-side (see src/server.js's handler) - it never enqueues by
    // itself. The real "join the queue" action is POST /api/rooms/:id/join (same as the desktop
    // poczekalnia.html flow, and the same endpoint the Pokoje tab's joinRoom() already uses) -
    // without it, "Szukaj gry" looked like it did something (switched to the waiting screen) but the
    // server was never actually told to add this player to matchmaking.
    async function showMiniMatchmakingScreen(room) {
        currentRoom = room;
        currentRoomId = room._id;
        isMiniWaiting = true;
        resetWaitingUi();
        $('waitingTitle').textContent = 'Szukam graczy do Mini-Turnieju...';
        try {
            const res = await fetch(API_BASE + '/api/rooms/' + room._id + '/join', { method: 'POST', headers: authHeaders() });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                toast(d.error || 'Nie udało się rozpocząć szukania gry.');
                showTournamentsScreen();
                return;
            }
            ensureSocket();
            socket.emit('matchmaking:join', { id: myUserId, roomId: room._id });
        } catch (err) {
            toast('Nie udało się rozpocząć szukania gry — sprawdź połączenie.');
            showTournamentsScreen();
        }
    }

    // ================= POCZEKALNIA (lista graczy na żywo) =================
    // Trzy różne systemy startu rundy, dokładnie jak desktopowe poczekalnia.html:
    // - 'standard': start automatyczny, gdy pokój jest pełny (juz obslugiwane ponizej bez zmian).
    // - 'percentage': gracze soami zaznaczaja "Gotowy" (lobby:toggleReady), start gdy >=5 graczy
    //   i wszyscy gotowi.
    // - 'team': gracze najpierw wybieraja druzyne (lobby:setTeam, max 5/druzyne), potem "Gotowy" -
    //   start gdy kazdy ma druzyne, sa min. 2 rozne druzyny, i wszyscy gotowi. Bez tego ekranu
    //   pokoj drużynowy/procentowy w aplikacji mobilnej nigdy by sie nie rozpoczal - gracz
    //   siedzialby w poczekalni w nieskonczonosc, bo nic nigdy nie ustawia flagi ready.
    function renderLobbyHeader() {
        if (!currentRoom) return;
        $('lobbyRoomName').textContent = currentRoom.nazwaPokoju || currentRoom.roomName || 'Pokój';
        const durationMin = Math.round((currentRoom.ustawienia?.dlugoscRundySekundy || 3600) / 60);
        const modeText = currentRoom.roomType === 'team' ? ` · Drużynowy (${currentRoom.teamCount || 2} drużyny)` : currentRoom.roomType === 'percentage' ? ' · Tryb gotowości' : '';
        $('lobbySettings').textContent = 'Czas rundy: ' + durationMin + ' min · Prędkość ' + (currentRoom.speedFactor ?? 1) + 'x' + modeText;
    }

    function showLobbyScreen(room) {
        showScreen('screen-lobby');
        renderLobbyHeader();
        $('lobbyCountdown').textContent = '';
        $('lobbyPlayersList').innerHTML = '<p class="hint-text">Oczekiwanie na graczy...</p>';
        $('btnAddBot').style.display = 'none';
        $('btnLobbyReady').style.display = 'none';
        ensureSocket();
        socket.emit('lobby:join', { id: myUserId, roomId: room._id });
    }

    function renderLobbyPlayers(players) {
        const list = players || [];
        const isTeamRoom = currentRoom?.roomType === 'team';
        const isPercentageRoom = currentRoom?.roomType === 'percentage';
        const me = list.find((p) => p.userId === myUserId);

        if (isTeamRoom) {
            renderTeamLobbyList(list);
        } else {
            $('lobbyPlayersList').innerHTML = list.length
                ? list.map((p) => `
                    <div class="row-item lobby-player-row">
                        <span class="color-dot" style="background:${p.color || '#475569'}"></span>
                        <span class="row-title">${p.username}</span>
                        ${isPercentageRoom ? `<span class="ready-badge${p.isBot || p.ready ? ' is-ready' : ''}">${p.isBot || p.ready ? '✓ Gotowy' : 'Oczekuje'}</span>` : ''}
                        ${p.isBot ? '<span class="bot-badge">BOT</span>' : ''}
                    </div>`).join('')
                : '<p class="hint-text">Oczekiwanie na graczy...</p>';
        }

        const max = currentRoom?.maxGraczy ?? currentRoom?.maxPlayers ?? 10;
        $('btnAddBot').style.display = (!isTeamRoom && currentRoom?.playersCanAddBots && list.length < max) ? 'block' : 'none';

        const readyBtn = $('btnLobbyReady');
        if (isPercentageRoom || isTeamRoom) {
            readyBtn.style.display = 'block';
            const canReady = !isTeamRoom || (me && me.teamId != null);
            readyBtn.disabled = !canReady;
            readyBtn.textContent = !canReady ? 'Najpierw wybierz drużynę' : (me?.ready ? '✓ Gotowy (dotknij, by cofnąć)' : 'Gotowy');
        } else {
            readyBtn.style.display = 'none';
        }
    }

    function renderTeamLobbyList(list) {
        const teamCount = currentRoom?.teamCount || 2;
        const regionSize = window.GameEngine?.TEAM_REGION_SIZE || 5;
        const isAdmin = !!myProfile?.isAdmin;
        let html = '';
        for (let teamId = 1; teamId <= teamCount; teamId++) {
            const members = list.filter((p) => p.teamId === teamId);
            const isFull = members.length >= regionSize;
            const isMyTeam = members.some((p) => p.userId === myUserId);
            html += `<div class="panel-card team-lobby-slot">
                <div class="ranking-header-row">
                    <h3>Drużyna ${teamId} (${members.length}/${regionSize})</h3>
                    ${!isMyTeam && !isFull ? `<button class="row-action" data-join-team="${teamId}">Dołącz</button>` : ''}
                </div>
                ${members.map((p) => `
                    <div class="row-item lobby-player-row">
                        <span class="color-dot" style="background:${p.color || '#475569'}"></span>
                        <span class="row-title">${p.username}${p.userId === myUserId ? ' (Ty)' : ''}</span>
                        <span class="ready-badge${p.isBot || p.ready ? ' is-ready' : ''}">${p.isBot || p.ready ? '✓' : '…'}</span>
                        ${p.isBot ? '<span class="bot-badge">BOT</span>' : ''}
                    </div>`).join('') || '<p class="hint-text">Brak graczy.</p>'}
                ${isAdmin && !isFull ? `<button class="row-action" data-add-bot-team="${teamId}" style="margin-top:8px; width:100%;">+ Dodaj bota</button>` : ''}
            </div>`;
        }
        const el = $('lobbyPlayersList');
        el.innerHTML = html;
        el.querySelectorAll('[data-join-team]').forEach((btn) => {
            btn.addEventListener('click', () => socket.emit('lobby:setTeam', { roomId: currentRoomId, teamId: Number(btn.dataset.joinTeam) }));
        });
        el.querySelectorAll('[data-add-bot-team]').forEach((btn) => {
            btn.addEventListener('click', () => socket.emit('lobby:addBotToTeam', { roomId: currentRoomId, teamId: Number(btn.dataset.addBotTeam) }));
        });
    }

    $('btnAddBot').addEventListener('click', () => {
        socket.emit('lobby:addBot', currentRoomId);
    });
    // lobby:toggleReady takes no ack (see its server handler) - failures arrive via the generic
    // 'error' event, already toasted by the socket.on('error', ...) handler below.
    $('btnLobbyReady').addEventListener('click', () => {
        socket.emit('lobby:toggleReady', currentRoomId);
    });

    $('btnLeaveLobby').addEventListener('click', async () => {
        try {
            await fetch(API_BASE + '/api/rooms/' + currentRoomId + '/leave', { method: 'POST', headers: authHeaders() });
        } catch (err) { /* best effort */ }
        if (currentRoom?.isMiniTournament) showTournamentsScreen(); else showRoomsScreen();
    });

    function resetWaitingUi() {
        showScreen('screen-waiting');
        $('waitingSubtitle').textContent = '';
        $('btnAcceptMatch').style.display = 'none';
        $('waitingSpinner').style.display = 'block';
        currentMatchId = null;
    }

    $('btnCancelWaiting').addEventListener('click', async () => {
        try {
            await fetch(API_BASE + '/api/rooms/' + currentRoomId + '/leave', { method: 'POST', headers: authHeaders() });
        } catch (err) { /* best effort */ }
        if (isMiniWaiting) showTournamentsScreen(); else showRoomsScreen();
    });

    $('btnAcceptMatch').addEventListener('click', () => {
        socket.emit('matchmaking:accept', { roomId: currentRoomId, matchId: currentMatchId });
        $('waitingTitle').textContent = 'Czekam na resztę graczy...';
        $('btnAcceptMatch').style.display = 'none';
        $('waitingSpinner').style.display = 'block';
    });

    // ================= SOCKET / ROUND LIFECYCLE =================
    function ensureSocket() {
        if (socket) return;
        socket = io(API_BASE, { auth: { token: authToken, deviceId: getDeviceId() } });

        // Socket.io auto-reconnects the transport (e.g. after the app is backgrounded/foregrounded
        // on the phone, or a brief network drop) but the SERVER's socket.currentGameRoundId is
        // per-connection state that a reconnect wipes — without re-sending game:join here, every
        // game:* command (queueBuilding, recruitUnit, sendAttack...) would keep failing with "Brak
        // aktywnej sesji gry" until the whole app was restarted, even mid-round.
        socket.on('connect', () => {
            if (gameState && gameState.roundId) socket.emit('game:join', { roundId: gameState.roundId });
        });

        // Always means "show the real player list now" — for a normal room this fires right after
        // joining; for a Mini-Turniej it's the one-time reveal once the whole group of 10 accepted
        // (see resolveMatch in src/server.js), which is why it switches away from screen-waiting.
        socket.on('lobby:update_list', (players) => {
            showScreen('screen-lobby');
            renderLobbyHeader();
            renderLobbyPlayers(players);
        });
        socket.on('countdown', ({ remaining }) => {
            $('lobbyCountdown').textContent = 'Start za ' + remaining + ' s...';
        });
        socket.on('gameStarted', ({ roundId }) => {
            joinActiveRound(roundId);
        });
        socket.on('game:init', ({ state, myUserId: uid }) => {
            clearResumeTimeout();
            myUserId = uid;
            roundFinishedShown = false; // fresh round session — see showRoundResults()
            teamChatMessages = [];
            applyState(state);
            showScreen('screen-game');
        });
        socket.on('game:state', (state) => applyState(state));
        socket.on('error', (msg) => toast(typeof msg === 'string' ? msg : 'Błąd serwera.'));
        socket.on('game:error', (msg) => {
            // If this error arrives while we're mid-resume (waiting on game:init after a
            // game:join), don't leave the player stuck on the resuming spinner — fall back to
            // the menu right away instead of waiting out the full RESUME_TIMEOUT_MS.
            if (resumeTimeoutHandle) { clearResumeTimeout(); showMenuScreen(); }
            toast(typeof msg === 'string' ? msg : 'Błąd gry.');
        });
        // Serwer wlasnie zablokowal to konto (wykryte multikonto lub decyzja admina) i zaraz
        // rozlaczy socket - mirror desktopowego account:blocked (game.js -> index.html): zamiast
        // zostawic gracza na ekranie ktory juz nic nie robi, wyloguj od razu i pokaz prawdziwy
        // powod (ten sam blockReason co przy logowaniu), nie tylko cichy rozlaczony socket.
        socket.on('account:blocked', async () => {
            if (socket) { socket.disconnect(); socket = null; }
            let reason = 'Twoje konto zostało zablokowane przez administrację.';
            try {
                // NOT /api/auth/me - the regular authMiddleware rejects a now-blocked account
                // outright. /api/me/block-status is the one route (authMiddlewareAllowBlocked)
                // a blocked account can still call, exactly the endpoint index.html itself uses
                // for this same purpose.
                const res = await fetch(API_BASE + '/api/me/block-status', { headers: authHeaders() });
                if (res.ok) { const data = await res.json(); if (data.blockReason) reason = data.blockReason; }
            } catch (err) { /* fall back to the generic reason above */ }
            localStorage.removeItem('authToken');
            authToken = null;
            gameState = null;
            showScreen('screen-login');
            $('loginError').textContent = reason;
        });
        // Koniec rundy — dokladnie ten sam dwuetapowy sygnal co desktopowe game.html: roundEnding
        // (kilka sekund przed faktycznym zakonczeniem, serwer w tle liczy payout/prizeResults) potem
        // roundFinished (albo po prostu game:state z roundStatus:'finished', dla kogos kto wlasnie
        // dolaczyl/odswiezyl juz PO zakonczeniu - patrz applyState).
        socket.on('roundEnding', ({ countdownSeconds }) => showRoundEndingOverlay(countdownSeconds || 5));
        socket.on('roundFinished', () => showRoundResults());
        // Czat drużynowy (tylko tryb team, patrz socket.currentTeamId po stronie serwera) — historia
        // przychodzi raz przy game:join, kolejne wiadomości jako zwykłe zdarzenia. Re-renderuje Mapę
        // tylko gdy jest aktualnie otwarta i pole tekstowe nie jest w trakcie edycji (patrz
        // isEditingQuantityInput) — dokładnie ten sam wzorzec co reszta ekranu gry.
        socket.on('game:teamChatHistory', (history) => {
            teamChatMessages = Array.isArray(history) ? history : [];
            if (activeTab === 'map' && !isEditingQuantityInput()) renderMapTab();
        });
        socket.on('game:teamChatMessage', (msg) => {
            teamChatMessages.push(msg);
            if (teamChatMessages.length > 200) teamChatMessages.shift();
            if (activeTab === 'map' && !isEditingQuantityInput()) renderMapTab();
        });

        // ---- Mini-Turniej blind matchmaking (see joinMiniTournamentQueue/resolveMatch in
        // src/server.js) — nicknames stay hidden until the whole group of 10 accepts. ----
        socket.on('matchmaking:state', ({ phase, deadlineAt }) => {
            if (phase === 'matchFound') showMatchFoundUi(deadlineAt);
            else if (phase === 'searching') { $('waitingTitle').textContent = 'Szukam graczy do Mini-Turnieju...'; }
        });
        socket.on('matchmaking:matchFound', ({ matchId, deadlineAt }) => {
            currentMatchId = matchId;
            showMatchFoundUi(deadlineAt);
        });
        socket.on('matchmaking:requeued', () => {
            toast('Wróciłeś do kolejki z pierwszeństwem.');
            resetWaitingUi();
            $('waitingTitle').textContent = 'Szukam graczy do Mini-Turnieju...';
        });
        socket.on('matchmaking:removed', () => {
            toast('Zostałeś usunięty z kolejki (brak reakcji na czas).');
            showTournamentsScreen();
        });
    }

    function showMatchFoundUi(deadlineAt) {
        $('waitingTitle').textContent = '✅ Mecz znaleziony!';
        $('waitingSpinner').style.display = 'none';
        $('btnAcceptMatch').style.display = 'block';
        const tick = () => {
            const remain = Math.max(0, Math.round((deadlineAt - Date.now()) / 1000));
            $('waitingSubtitle').textContent = 'Potwierdź w ciągu ' + remain + ' s';
            if (remain > 0 && $('btnAcceptMatch').style.display !== 'none') setTimeout(tick, 500);
        };
        tick();
    }

    function connectSocketAndJoinRound(roundId) {
        ensureSocket();
        joinActiveRound(roundId);
    }

    function joinActiveRound(roundId) {
        socket.emit('game:join', { roundId });
    }

    // "Wyjdź z gry" (in-game topbar) ONLY leaves to the menu now - it does NOT forfeit the round.
    // It used to call /api/rounds/:id/forfeit, which permanently ended the player's participation -
    // meaning anyone who used this just to switch devices (e.g. continue on the browser version)
    // would find their round already over by the time they got there. The round stays fully active;
    // "Wróć do gry" on the menu resumes it normally. Actually forfeiting is now its own separate,
    // explicit action - the red "Opuść grę" button next to "Wróć do gry" (see below).
    let exitConfirmPending = false;
    $('btnExitGame').addEventListener('click', () => {
        if (!exitConfirmPending) {
            exitConfirmPending = true;
            const btn = $('btnExitGame');
            const original = btn.textContent;
            btn.textContent = 'Na pewno? Dotknij ponownie';
            setTimeout(() => { exitConfirmPending = false; btn.textContent = original; }, 3000);
            return;
        }
        exitConfirmPending = false;
        $('btnExitGame').textContent = 'Wyjdź z gry';
        if (socket) { socket.disconnect(); socket = null; }
        gameState = null;
        showMenuScreen();
    });

    // Faktyczne opuszczenie/poddanie rundy (POST /api/rounds/:id/forfeit) - osobna, jawna akcja na
    // ekranie menu, oddzielona od zwyklego "Wyjdz do menu" powyzej. Dziala niezaleznie od tego, czy
    // gameState jest akurat wypelnione (gracz mogl wejsc prosto w menu bez wczesniejszego
    // dolaczenia w tej sesji) - sprawdza aktywna runde przez /api/game/state tak samo jak "Wroc do
    // gry".
    let leaveConfirmPending = false;
    $('btnLeaveGame').addEventListener('click', async () => {
        if (!leaveConfirmPending) {
            leaveConfirmPending = true;
            const btn = $('btnLeaveGame');
            const original = btn.textContent;
            btn.textContent = 'Na pewno?';
            setTimeout(() => { leaveConfirmPending = false; btn.textContent = original; }, 3000);
            return;
        }
        leaveConfirmPending = false;
        $('btnLeaveGame').textContent = '🚪 Opuść grę';
        try {
            const res = await fetch(API_BASE + '/api/game/state', { headers: authHeaders() });
            if (res.status !== 200) { toast('Brak aktywnej rozgrywki do opuszczenia.'); return; }
            const data = await res.json();
            await fetch(API_BASE + '/api/rounds/' + data.state.roundId + '/forfeit', { method: 'POST', headers: authHeaders() });
            toast('Opuszczono rozgrywkę.');
        } catch (err) {
            toast('Nie udało się opuścić rozgrywki — sprawdź połączenie.');
        }
    });

    // On a real phone, rebuilding a focused <input>'s DOM node (even preserving its value, see
    // recruitQtyCache/mapUnitQtyCache above) still destroys and recreates the element — which
    // drops focus, and a focused element losing focus is exactly what makes the on-screen keyboard
    // dismiss itself. The server pushes a fresh game:state roughly once a second (economy tick, or
    // any other player's move), so without this guard the keyboard would flash open then vanish
    // within about a second of tapping a quantity field, on every single keystroke attempt. Simply
    // skipping the whole tab rebuild while a tracked quantity input is focused sidesteps this
    // entirely — countdown timers on screen go a few seconds stale while typing, which is a fair
    // trade for the field being usable at all.
    function isEditingQuantityInput() {
        const el = document.activeElement;
        return !!(el && (el.hasAttribute('data-qty') || el.hasAttribute('data-map-unit') || el.hasAttribute('data-team-chat-input')));
    }

    function applyState(state) {
        gameState = state;
        const me = (state.players || []).find((p) => p.userId === myUserId);
        myPlayerName = me ? me.name : myPlayerName;

        const myVillages = Object.values(state.villages || {}).filter((v) => v.owner === myPlayerName);
        if (!selectedVillageId || !myVillages.some((v) => v.id === selectedVillageId)) {
            selectedVillageId = myVillages[0] ? myVillages[0].id : null;
        }
        renderVillageSwitcher(myVillages);
        renderTopbar(me, state);
        if (!isEditingQuantityInput()) renderActiveTab();
        if (state.roundStatus === 'finished') showRoundResults();
    }

    function renderTopbar(me, state) {
        $('statGold').textContent = me ? Math.floor(me.gold) : 0;
        const v = getSelectedVillage();
        if (v && window.GameEngine) {
            const used = GameEngine.computeVillagePopulationUsed(v) + GameEngine.computeVillageReservedPopulation(v);
            const capacity = GameEngine.getVillagePopulationCapacity(v);
            $('statPop').textContent = used + '/' + capacity;
        }
        if (state.roundStatus === 'finished') {
            $('statTimer').textContent = 'Zakończona';
        } else if (state.roundEndsAt) {
            const remain = Math.max(0, state.roundEndsAt - Date.now());
            $('statTimer').textContent = formatDuration(remain);
        }
    }

    // Rebuilding a native <select>'s options every ~1s (this runs on every game:state tick, same as
    // the rest of the screen) makes it visibly flicker/close-and-reopen whenever the dropdown is
    // open — the exact same "destructive rebuild while the user is interacting" bug already fixed
    // for the quantity inputs, just for a <select> instead of an <input>. Fix: only touch innerHTML
    // when the actual village list changed (bought a village, lost one), never on an ordinary tick
    // where the list is identical.
    let villageSwitcherSignature = null;
    function renderVillageSwitcher(myVillages) {
        const sel = $('villageSwitcher');
        const signature = myVillages.map((v) => `${v.id}:${v.label}:${v.type}`).join('|');
        if (signature !== villageSwitcherSignature) {
            villageSwitcherSignature = signature;
            sel.innerHTML = myVillages.map((v) => `<option value="${v.id}">${v.label}${v.type === 'sub' ? ' (poddana)' : ''}</option>`).join('');
        }
        if (sel.value !== (selectedVillageId || '')) sel.value = selectedVillageId || '';
    }
    $('villageSwitcher').addEventListener('change', (e) => {
        selectedVillageId = e.target.value;
        renderActiveTab();
    });

    function getSelectedVillage() {
        if (!gameState || !selectedVillageId) return null;
        return gameState.villages[selectedVillageId] || null;
    }

    // ================= BOTTOM NAV =================
    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
            $('tab-' + activeTab).classList.add('active');
            renderActiveTab();
        });
    });

    function renderActiveTab() {
        if (!gameState) return;
        if (activeTab === 'build') renderBuildTab();
        else if (activeTab === 'map') renderMapTab();
        else if (activeTab === 'army') renderArmyTab();
        else if (activeTab === 'ranking') renderRankingTab();
        else if (activeTab === 'reports') renderReportsTab();
    }

    // ---------------- ROZBUDOWA ----------------
    function renderBuildTab() {
        const v = getSelectedVillage();
        const el = $('tab-build');
        if (!v) { el.innerHTML = '<p class="hint-text">Brak wioski do wyświetlenia.</p>'; return; }
        const buildingsHtml = (v.buildings || []).map((b) => {
            const projectedLevel = GameEngine.getProjectedBuildingLevel(v, b.id);
            const maxed = projectedLevel >= b.maxLevel;
            const queueFull = (v.buildQueue || []).length >= 3;
            const nextLevel = projectedLevel + 1;
            const cost = GameEngine.getBuildingCost(b, nextLevel);
            const timeSec = GameEngine.getBuildingTime(b, nextLevel);
            return `
            <div class="row-item">
                <div>
                    <div class="row-title">${b.label} — poz. ${b.level}/${b.maxLevel}${projectedLevel !== b.level ? ' (+' + (projectedLevel - b.level) + ' w kolejce)' : ''}</div>
                    <div class="row-sub">${maxed ? 'Maksymalny poziom' : 'Poz. ' + nextLevel + ': ' + cost + ' zł · ' + formatDuration(timeSec * 1000)}</div>
                </div>
                <button class="row-action" data-building="${b.id}" ${maxed || queueFull ? 'disabled' : ''}>Rozbuduj</button>
            </div>`;
        }).join('');
        el.innerHTML = `
            <div class="panel-card">
                <h3>${v.label} — budynki</h3>
                ${buildingsHtml}
            </div>
            <div class="panel-card">
                <h3>Kolejka budowy (${(v.buildQueue || []).length}/3)</h3>
                ${(v.buildQueue || []).map((q, i) => `
                    <div class="row-item">
                        <div>
                            <div class="row-title">${q.name} → poz. ${q.targetLevel}</div>
                            <div class="row-sub">${countdownText(q.endTime)}</div>
                            <div class="progress-bar"><div class="progress-bar-fill" style="width:${queueProgress(q)}%"></div></div>
                        </div>
                        <button class="row-action danger" data-cancel-build="${i}">Anuluj</button>
                    </div>`).join('') || '<p class="hint-text">Pusta kolejka.</p>'}
            </div>`;

        el.querySelectorAll('[data-building]').forEach((btn) => {
            btn.addEventListener('click', () => {
                socket.emit('game:queueBuilding', { villageId: v.id, buildingId: btn.dataset.building }, (ack) => {
                    if (ack && ack.ok === false) toast(ack.error || 'Nie udało się rozbudować.');
                });
            });
        });
        el.querySelectorAll('[data-cancel-build]').forEach((btn) => {
            btn.addEventListener('click', () => {
                socket.emit('game:cancelBuilding', { villageId: v.id, index: Number(btn.dataset.cancelBuild) }, (ack) => {
                    if (ack && ack.ok === false) toast(ack.error || 'Nie udało się anulować.');
                });
            });
        });
    }
    function queueProgress(q) {
        const total = q.endTime - q.startTime;
        const done = Date.now() - q.startTime;
        return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    }

    // ---------------- MAPA ----------------
    // Same background image + percentage-based node positions as the desktop client
    // (public/game.html's #imageCard/.map-node, public/game.js's renderMapNodes) — loaded remotely
    // so the map always matches whatever art the desktop version currently uses. Tapping a village
    // opens an inline action panel right below the map (info + wyślij atak/zwiad/wsparcie + unit
    // picker + active movements) — mirrors the desktop's showMapActionPanel, collapsed into one
    // simplified, single-stage form instead of its multi-step confirm flow.
    let mapActionMode = null; // null | 'attack' | 'recon' | 'support' — which inline form is open
    // The server pushes a fresh game:state roughly once a second (economy tick, or any other
    // player's action) — applyState() re-renders whatever tab is open every time that arrives, which
    // would otherwise recreate these <input> elements from scratch and silently reset a
    // still-being-typed quantity back to its default before the player could ever click Send. These
    // caches are updated on every keystroke and used as the input's value on every re-render, so a
    // rebuild mid-typing keeps whatever was last typed instead of wiping it.
    const mapUnitQtyCache = {};
    const recruitQtyCache = {};

    function renderMapTab() {
        const el = $('tab-map');
        if (!gameState) return;
        const isTeam = gameState.mapType === 'team';
        const bgUrl = isTeam ? API_BASE + '/mapa%20druzyna.png' : API_BASE + '/mapa.png';
        const ratio = isTeam ? '1448 / 1086' : '1035 / 742';
        el.innerHTML = `
            <div class="map-image-card" id="mapImageCard" style="aspect-ratio:${ratio}; background-image:url('${bgUrl}');"></div>
            <div id="mapActionPanel" class="panel-card"></div>
            <div class="panel-card">
                <h3>Ruchy wojsk</h3>
                <div id="mapMovementsList"></div>
            </div>
            ${isTeam ? `<div class="panel-card">
                <h3>💬 Czat drużynowy</h3>
                <div id="teamChatList" class="team-chat-list"></div>
                <div class="team-chat-input-row">
                    <input type="text" id="teamChatInput" data-team-chat-input maxlength="300" placeholder="Napisz do drużyny...">
                    <button class="row-action" id="btnTeamChatSend">Wyślij</button>
                </div>
            </div>` : ''}`;
        const card = $('mapImageCard');
        (gameState.mapNodes || []).forEach((node) => {
            const village = gameState.villages[node.id];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'map-node ' + node.type + (attackTargetId === node.id ? ' selected' : '');
            btn.style.left = node.x + '%';
            btn.style.top = node.y + '%';
            btn.textContent = node.type === 'main' ? node.id.replace('W', '') : '';
            btn.dataset.nodeId = node.id;
            if (village && village.owner && village.color) {
                btn.style.borderColor = village.color;
                btn.style.borderWidth = '2.5px';
                btn.style.backgroundColor = 'transparent';
            }
            btn.addEventListener('click', () => {
                attackTargetId = node.id;
                mapActionMode = null;
                Object.keys(mapUnitQtyCache).forEach((key) => delete mapUnitQtyCache[key]);
                renderMapTab();
            });
            card.appendChild(btn);
        });
        renderMapActionPanel();
        renderMapMovements();
        if (isTeam) renderTeamChat();
    }

    function renderTeamChat() {
        const list = $('teamChatList');
        list.innerHTML = teamChatMessages.map((m) => `
            <div class="team-chat-msg${m.username === myPlayerName ? ' mine' : ''}">
                <span class="team-chat-author">${m.username}</span>
                <span class="team-chat-text">${m.text}</span>
            </div>`).join('') || '<p class="hint-text">Brak wiadomości.</p>';
        list.scrollTop = list.scrollHeight;
        const send = () => {
            const input = $('teamChatInput');
            const text = input.value.trim();
            if (!text) return;
            socket.emit('game:teamChatMessage', text);
            input.value = '';
        };
        $('btnTeamChatSend').addEventListener('click', send);
        $('teamChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    }

    // Support troops garrisoned at one of YOUR OWN villages (sent from another of your villages, or
    // from a teammate's in team mode — see gameEngine.js's recallSupport/reinforcements) can be
    // called back home. Mirrors desktop's renderReinforcements() in public/game.js.
    function renderReinforcementsBlock(village) {
        const batches = Array.isArray(village.reinforcements) ? village.reinforcements : [];
        if (!batches.length) return '';
        const rows = batches.map((batch) => {
            const summary = Object.entries(batch.units || {}).filter(([, c]) => c > 0)
                .map(([unitId, c]) => `${UNIT_LABELS[unitId] || unitId} x${c}`).join(', ') || 'brak';
            const fromAlly = batch.ownerName && batch.ownerName !== myPlayerName ? ` (od ${batch.ownerName})` : '';
            return `<div class="row-item">
                <div><div class="row-title">${batch.sourceLabel || batch.sourceVillageId}${fromAlly}</div><div class="row-sub">${summary}</div></div>
                <button class="row-action danger" data-recall="${batch.id}">Odwołaj</button>
            </div>`;
        }).join('');
        return `<div class="panel-card" style="margin-top:8px;"><h3>🛡️ Wsparcie w wiosce</h3>${rows}</div>`;
    }
    function wireReinforcementRecallButtons(panel) {
        panel.querySelectorAll('[data-recall]').forEach((btn) => {
            btn.addEventListener('click', () => {
                socket.emit('game:recallSupport', { villageId: attackTargetId, reinforcementId: btn.dataset.recall }, (ack) => {
                    if (ack && ack.ok === false) { toast(ack.error || 'Nie udało się odwołać wsparcia.'); return; }
                    toast('Wsparcie wraca do domu.');
                    renderMapActionPanel();
                });
            });
        });
    }

    function renderMapActionPanel() {
        const panel = $('mapActionPanel');
        if (!attackTargetId) {
            panel.innerHTML = '<p class="hint-text">Dotknij wioskę na mapie, żeby zobaczyć informacje i wysłać wojsko.</p>';
            return;
        }
        const node = gameState.mapNodes.find((n) => n.id === attackTargetId);
        const village = gameState.villages[attackTargetId];
        const isMine = village && village.owner === myPlayerName;
        // Same three-way rule as desktop's public/game.js (canPurchaseSubVillage/canAttackTargetVillage):
        // an unowned village adjacent to one of YOUR OWN villages can be bought for
        // GameEngine.auxiliaryVillageCost; an unowned village is only attackable in team mode (a Lord
        // captures it outright, no defenders); any other unowned village (classic mode, not adjacent to
        // you) has no action at all — matches server-side buyVillage/canAttackVillage exactly instead of
        // the old (wrong) "not mine = attackable" shortcut, which offered Attack/Zwiad on a village that
        // had no owner and thus nothing to attack.
        const parentId = window.GameEngine && village ? GameEngine.getVillageParentId(village) : null;
        const parentVillage = parentId ? gameState.villages[parentId] : null;
        const canBuy = !!(village && !village.owner && parentVillage && parentVillage.owner === myPlayerName);
        const isCapturableNeutral = !!(village && !village.owner && gameState.mapType === 'team');
        const canAttackTarget = !!(village && village.owner && village.owner !== myPlayerName) || isCapturableNeutral;
        // Garrison counts only ever shown for the player's OWN villages — never reveal an enemy's
        // exact troop numbers through the map panel, only who owns the village.
        let html = `<h3>${node.label}</h3>
            <p class="row-sub">Właściciel: ${village?.owner || 'Niezajęta'}</p>`;
        if (isMine) {
            const garrisonText = Object.entries(village.garrison || {}).filter(([, c]) => c > 0).map(([id, c]) => `${UNIT_LABELS[id] || id}: ${c}`).join(', ') || 'brak wojsk';
            html += `<p class="row-sub">Garnizon: ${garrisonText}</p>`;
            html += renderReinforcementsBlock(village);
        }

        if (!mapActionMode) {
            html += '<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">';
            if (canBuy) html += `<button class="row-action" id="btnMapBuy">🏠 Wykup wioskę (${formatNumber(window.GameEngine ? GameEngine.auxiliaryVillageCost : 4000)} zł)</button>`;
            else if (canAttackTarget) html += `<button class="row-action" id="btnMapAttack">⚔️ Wyślij atak</button><button class="row-action" id="btnMapRecon">👁️ Zwiad</button>`;
            if (isMine && village.id !== selectedVillageId) html += `<button class="row-action" id="btnMapSupport">🛡️ Wyślij wsparcie</button>`;
            html += '</div>';
            panel.innerHTML = html;
            $('btnMapAttack')?.addEventListener('click', () => { mapActionMode = 'attack'; renderMapActionPanel(); });
            $('btnMapRecon')?.addEventListener('click', () => { mapActionMode = 'recon'; renderMapActionPanel(); });
            $('btnMapSupport')?.addEventListener('click', () => { mapActionMode = 'support'; renderMapActionPanel(); });
            $('btnMapBuy')?.addEventListener('click', () => {
                socket.emit('game:buyVillage', { villageId: village.id }, (ack) => {
                    if (ack && ack.ok === false) { toast(ack.error || 'Nie udało się wykupić wioski.'); return; }
                    toast('Wioska wykupiona!');
                    renderMapTab();
                });
            });
            wireReinforcementRecallButtons(panel);
            return;
        }

        // Formularz wysyłki — zawsze z aktualnie wybranej (przełącznik na górze) własnej wioski do
        // wioski wskazanej na mapie. Zwiad może korzystać tylko ze zwiadowców (serwer i tak to
        // wymusza — GameEngine.sendAttack — to tylko ogranicza listę dla przejrzystości formularza).
        const sourceVillage = gameState.villages[selectedVillageId];
        const unitList = mapActionMode === 'recon' ? UNIT_DEFS.filter((u) => u.id === 'scout') : UNIT_DEFS.filter((u) => u.id !== 'lord');
        html += `<p class="row-sub">Z wioski: <strong>${sourceVillage?.label || '?'}</strong></p>
            <div class="attack-form">
                <div class="unit-table-wrap"><table class="unit-table">
                    <thead><tr><th>Jednostka</th><th>Ilość</th><th>Stan</th></tr></thead>
                    <tbody>
                        ${unitList.map((u) => `<tr>
                            <td>${u.label}</td>
                            <td class="ut-qty"><input type="number" class="qty-input" min="0" placeholder="0" value="${mapUnitQtyCache[u.id] ?? ''}" data-map-unit="${u.id}"></td>
                            <td class="ut-stan">${formatNumber(sourceVillage?.garrison?.[u.id] || 0)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table></div>
                <button class="row-action" id="btnMapSend">Wyślij</button>
                <button class="row-action danger" id="btnMapCancelForm">Anuluj</button>
            </div>`;
        panel.innerHTML = html;
        wireReinforcementRecallButtons(panel);
        panel.querySelectorAll('[data-map-unit]').forEach((inp) => {
            inp.addEventListener('input', () => { mapUnitQtyCache[inp.dataset.mapUnit] = inp.value; });
        });
        $('btnMapCancelForm').addEventListener('click', () => { mapActionMode = null; renderMapActionPanel(); });
        $('btnMapSend').addEventListener('click', () => {
            const selectedUnits = {};
            unitList.forEach((u) => {
                const n = Number(panel.querySelector(`[data-map-unit="${u.id}"]`).value) || 0;
                if (n > 0) selectedUnits[u.id] = n;
            });
            if (!Object.keys(selectedUnits).length) { toast('Wybierz przynajmniej jedną jednostkę.'); return; }
            const eventName = mapActionMode === 'support' ? 'game:sendSupport' : 'game:sendAttack';
            const payload = mapActionMode === 'support'
                ? { sourceVillageId: selectedVillageId, targetVillageId: attackTargetId, selectedUnits }
                : { sourceVillageId: selectedVillageId, targetVillageId: attackTargetId, selectedUnits, mode: mapActionMode };
            socket.emit(eventName, payload, (ack) => {
                if (ack && ack.ok === false) { toast(ack.error || 'Nie udało się wysłać.'); return; }
                toast('Wysłano!');
                mapActionMode = null;
                attackTargetId = null;
                Object.keys(mapUnitQtyCache).forEach((key) => delete mapUnitQtyCache[key]);
                renderMapTab();
            });
        });
    }

    function renderMapMovements() {
        const attacks = (gameState.attacks || []).filter((a) => a.attackerName === myPlayerName || a.targetPlayerName === myPlayerName);
        const el = $('mapMovementsList');
        el.innerHTML = attacks.map((a) => {
            // Only a genuine outbound "attack" (not recon/support/an-already-turned-around "return")
            // that's still travelling and that I sent can be recalled — mirrors GameEngine.cancelOutgoingAttack's
            // own checks, just kept in sync client-side so the button only appears when it would work.
            const canCancel = a.direction === 'attack' && a.attackerName === myPlayerName && a.arrivesAt > Date.now();
            return `<div class="row-item">
                <div>
                    <div class="row-title">${a.direction === 'attack' ? '⚔️ Atak' : a.direction === 'recon' ? '👁️ Zwiad' : a.direction === 'support' ? '🛡️ Wsparcie' : '↩️ Powrót'} ${a.sourceVillageId} → ${a.targetVillageId}</div>
                    <div class="row-sub">${countdownText(a.arrivesAt)}</div>
                </div>
                ${canCancel ? `<button class="row-action danger" data-cancel-attack="${a.id}">Odwołaj</button>` : ''}
            </div>`;
        }).join('') || '<p class="hint-text">Brak wojsk w drodze.</p>';
        el.querySelectorAll('[data-cancel-attack]').forEach((btn) => {
            btn.addEventListener('click', () => {
                socket.emit('game:cancelAttack', { attackId: btn.dataset.cancelAttack }, (ack) => {
                    if (ack && ack.ok === false) { toast(ack.error || 'Nie udało się odwołać ataku.'); return; }
                    toast('Atak zawrócony.');
                });
            });
        });
    }

    // ---------------- WOJSKA (tylko rekrutacja — wysyłanie ataku/wsparcia jest teraz w zakładce
    // Mapa, bezpośrednio przy wybranej wiosce, żeby nie trzeba było przełączać zakładek) ----------
    function renderArmyTab() {
        const v = getSelectedVillage();
        const el = $('tab-army');
        if (!v) { el.innerHTML = '<p class="hint-text">Brak wioski do wyświetlenia.</p>'; return; }

        // Lord ma zupelnie inna mechanike niz zwykle jednostki (zawsze dokladnie 1, osobna kolejka
        // lordQueue, wymaga poziomu zamku i braku innego Lorda) - dlatego dostaje wlasny panel
        // ponizej zamiast wchodzic do listy z dowolna iloscia, ktora dla niego nie ma sensu.
        // Tabela zamiast osobnych wierszy tekstowych - "ile rekrutować" i "stan" (aktualna liczba w
        // garnizonie) widoczne od razu obok siebie, jedno miejsce zamiast doszukiwania się stanu
        // gdzie indziej.
        const recruitRows = `<div class="unit-table-wrap"><table class="unit-table">
            <thead><tr><th>Jednostka</th><th>Ilość</th><th>Stan</th><th></th></tr></thead>
            <tbody>
                ${UNIT_DEFS.filter((u) => u.id !== 'lord').map((u) => `<tr>
                    <td>${u.label}</td>
                    <td class="ut-qty"><input type="number" class="qty-input" min="1" placeholder="1" value="${recruitQtyCache[u.id] ?? ''}" data-qty="${u.id}"></td>
                    <td class="ut-stan">${formatNumber(v.garrison?.[u.id] || 0)}</td>
                    <td class="ut-action"><button class="row-action" data-recruit="${u.id}">Rekrutuj</button></td>
                </tr>`).join('')}
            </tbody>
        </table></div>`;

        const recruitQueueRows = (v.recruitQueue || []).map((q, i) => `
            <div class="row-item">
                <div>
                    <div class="row-title">${q.name} (${q.trainedUnits}/${q.count})</div>
                    <div class="row-sub">${countdownText(q.endTime)}</div>
                </div>
                <button class="row-action danger" data-cancel-recruit="${i}">Anuluj</button>
            </div>`).join('') || '<p class="hint-text">Pusta kolejka.</p>';

        el.innerHTML = `
            <div class="panel-card">
                <h3>${v.label} — rekrutacja</h3>
                ${recruitRows}
            </div>
            <div class="panel-card">
                <h3>Kolejka rekrutacji</h3>
                ${recruitQueueRows}
            </div>
            <div class="panel-card">
                <h3>👑 Lord</h3>
                ${renderLordSection(v)}
            </div>`;

        el.querySelectorAll('[data-qty]').forEach((inp) => {
            inp.addEventListener('input', () => { recruitQtyCache[inp.dataset.qty] = inp.value; });
        });
        el.querySelectorAll('[data-recruit]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const unitId = btn.dataset.recruit;
                const count = Number(el.querySelector(`[data-qty="${unitId}"]`).value) || 1;
                socket.emit('game:recruitUnit', { villageId: v.id, unitId, count }, (ack) => {
                    if (ack && ack.ok === false) toast(ack.error || 'Nie udało się rekrutować.');
                    else { toast('Zlecono rekrutację.'); delete recruitQtyCache[unitId]; renderArmyTab(); }
                });
            });
        });
        el.querySelectorAll('[data-cancel-recruit]').forEach((btn) => {
            btn.addEventListener('click', () => {
                socket.emit('game:cancelRecruit', { villageId: v.id, index: Number(btn.dataset.cancelRecruit) }, (ack) => {
                    if (ack && ack.ok === false) toast(ack.error || 'Nie udało się anulować.');
                });
            });
        });
        $('btnTrainLord')?.addEventListener('click', () => {
            socket.emit('game:recruitUnit', { villageId: v.id, unitId: 'lord', count: 1 }, (ack) => {
                if (ack && ack.ok === false) toast(ack.error || 'Nie udało się rozpocząć treningu Lorda.');
                else { toast('Trening Lorda rozpoczęty.'); renderArmyTab(); }
            });
        });
        $('btnCancelLord')?.addEventListener('click', () => {
            socket.emit('game:cancelLordRecruit', { villageId: v.id }, (ack) => {
                if (ack && ack.ok === false) toast(ack.error || 'Nie udało się anulować.');
                else renderArmyTab();
            });
        });
    }

    // Lord trenuje sie na wlasnej, niezaleznej kolejce (village.lordQueue) - patrz gameEngine.js -
    // wiec dostaje wlasny mini-panel obok garnizonu zamiast wchodzic do zwyklej listy rekrutacji.
    function renderLordSection(v) {
        const item = Array.isArray(v.lordQueue) ? v.lordQueue[0] : null;
        if (item) {
            return `<p class="row-sub">Lord pojawi się ${countdownText(item.endTime)}</p>
                <button class="row-action danger" id="btnCancelLord">Anuluj</button>`;
        }
        const canRecruit = window.GameEngine ? GameEngine.canRecruitLord(v) : true;
        if (!canRecruit) {
            return '<p class="hint-text">Wymaga Zamku poziom 5, braku innego Lorda w tej wiosce i obecności Lorda w domu (nie w drodze).</p>';
        }
        return '<button class="row-action" id="btnTrainLord">Trenuj Lorda</button>';
    }

    // ---------------- RANKING ----------------
    // Mirrors public/game.js's updateRanking()/updateTeamRanking() — same live, tick-driven
    // state.players data and the same points/pokonane (Atak/Obrona/Razem) toggle, just rendered as
    // stacked rows instead of the desktop's fixed-column sidebar table.
    function renderRankingTab() {
        const el = $('tab-ranking');
        const isTeamMode = gameState.mapType === 'team';
        const title = rankingMode === 'kills' ? 'Ranking pokonanych jednostek' : (isTeamMode ? 'Ranking drużyn' : 'Ranking graczy');
        const toggleLabel = rankingMode === 'kills' ? 'Pokaż punkty' : 'Pokaż pokonane';
        const killsHeader = rankingMode === 'kills'
            ? '<div class="ranking-kills-header"><span>Atak</span><span>Obrona</span><span>Razem</span></div>'
            : '';
        el.innerHTML = `
            <div class="panel-card ranking-panel-card">
                <div class="ranking-header-row">
                    <h3>${title}</h3>
                    <button class="row-action" id="btnToggleRanking">${toggleLabel}</button>
                </div>
                ${killsHeader}
                <div id="rankingRows"></div>
            </div>`;
        $('btnToggleRanking').addEventListener('click', () => {
            rankingMode = rankingMode === 'points' ? 'kills' : 'points';
            renderRankingTab();
        });
        if (isTeamMode) renderTeamRankingRows(); else renderPlayerRankingRows();
    }

    function killsValueMarkup(atk, def) {
        return `<span class="ranking-kills-cols"><span>${formatNumber(atk)}</span><span>${formatNumber(def)}</span><span>${formatNumber(atk + def)}</span></span>`;
    }

    function renderPlayerRankingRows() {
        const rows = $('rankingRows');
        const ranked = (gameState.players || [])
            .map((p) => ({ ...p, points: Number(p.points) || 0, killsAsAttacker: Number(p.killsAsAttacker) || 0, killsAsDefender: Number(p.killsAsDefender) || 0 }))
            .sort((a, b) => {
                if (rankingMode === 'kills') return b.killsAsAttacker - a.killsAsAttacker || (window.GameEngine ? GameEngine.comparePlayersByRank(a, b) : 0);
                return (window.GameEngine ? GameEngine.comparePlayersByRank(a, b) : b.points - a.points) || b.killsAsAttacker - a.killsAsAttacker;
            });
        rows.innerHTML = ranked.slice(0, 10).map((p, i) => {
            const value = rankingMode === 'kills' ? killsValueMarkup(p.killsAsAttacker, p.killsAsDefender) : `<span>${formatNumber(p.points)} pkt</span>`;
            const nameStyle = `color:${p.color || '#94a3b8'};${p.hasLeft ? ' text-decoration:line-through; opacity:0.6;' : ''}`;
            return `<div class="ranking-row" style="border-left-color:${p.color || '#94a3b8'};">
                <span><strong>${i + 1}.</strong> <span style="${nameStyle}">${p.name}${p.hasLeft ? ' (opuścił)' : ''}</span></span>
                ${value}
            </div>`;
        }).join('') || '<p class="hint-text">Brak graczy.</p>';
    }

    function renderTeamRankingRows() {
        const rows = $('rankingRows');
        const myTeamId = gameState.players.find((p) => p.userId === myUserId)?.teamId ?? null;
        const byTeam = new Map();
        gameState.players.forEach((p) => {
            if (p.teamId == null) return;
            if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, { teamId: p.teamId, color: p.color, totalPoints: 0, totalKillsAsAttacker: 0, totalKillsAsDefender: 0, earliestAt: Infinity });
            const t = byTeam.get(p.teamId);
            t.totalPoints += Number(p.points) || 0;
            t.totalKillsAsAttacker += Number(p.killsAsAttacker) || 0;
            t.totalKillsAsDefender += Number(p.killsAsDefender) || 0;
            const at = Number(p.pointsAchievedAt) || Infinity;
            if (at < t.earliestAt) t.earliestAt = at;
        });
        const teams = [...byTeam.values()].sort((a, b) => {
            if (rankingMode === 'kills') return b.totalKillsAsAttacker - a.totalKillsAsAttacker;
            return b.totalPoints - a.totalPoints || a.earliestAt - b.earliestAt;
        });
        rows.innerHTML = teams.slice(0, 10).map((t, i) => {
            const value = rankingMode === 'kills' ? killsValueMarkup(t.totalKillsAsAttacker, t.totalKillsAsDefender) : `<span>${formatNumber(t.totalPoints)} pkt</span>`;
            const isMyTeam = myTeamId != null && t.teamId === myTeamId;
            return `<div class="ranking-row" style="border-left-color:${t.color || '#94a3b8'};">
                <span><strong>${i + 1}.</strong> <span style="color:${t.color || '#94a3b8'};">Drużyna ${t.teamId}${isMyTeam ? ' (Twoja)' : ''}</span></span>
                ${value}
            </div>`;
        }).join('') || '<p class="hint-text">Brak drużyn.</p>';
    }

    // ---------------- RAPORTY ----------------
    // Mirrors public/game.js's renderReports()/isReportVisibleToPlayer/isReportInSelectedMode — same
    // state.reports data (a report is visible only to its own attacker/defender), same Ataki/Obrona
    // toggle, just rendered with native <details>/<summary> instead of a custom expand/collapse.
    function renderReportsTab() {
        const el = $('tab-reports');
        const me = myPlayerName;
        const visible = (gameState.reports || []).filter((r) => r.attackerName === me || r.defenderName === me);
        const inMode = visible.filter((r) => reportsMode === 'defense' ? r.defenderName === me : r.attackerName === me);
        const toggleLabel = reportsMode === 'defense' ? 'Pokaż ataki' : 'Pokaż obronę';
        el.innerHTML = `
            <div class="panel-card">
                <div class="ranking-header-row">
                    <h3>${reportsMode === 'defense' ? 'Raporty obrony' : 'Raporty ataków'}</h3>
                    <button class="row-action" id="btnToggleReports">${toggleLabel}</button>
                </div>
                <div id="reportsList"></div>
            </div>`;
        $('btnToggleReports').addEventListener('click', () => {
            reportsMode = reportsMode === 'attack' ? 'defense' : 'attack';
            renderReportsTab();
        });
        $('reportsList').innerHTML = inMode.length ? inMode.map(renderReportItem).join('') : '<p class="hint-text">Brak raportów.</p>';
    }

    function renderReportItem(r) {
        const me = myPlayerName;
        const isViewerDefender = me !== r.attackerName && me === r.defenderName;
        const viewerWon = isViewerDefender ? !r.success : r.success;
        const timeLabel = new Date(r.timestamp).toLocaleString('pl-PL');
        const headerLabel = r.type === 'battle' ? (viewerWon ? 'Zwycięstwo' : 'Porażka') : (r.outcome || (r.success ? 'Zwycięstwo' : 'Porażka'));
        const summary = `<summary class="round-result-row" style="cursor:pointer;">
            <span><strong>${headerLabel}</strong> — ${r.attackerName} (${r.sourceVillageLabel || '?'}) → ${r.defenderName || 'Nieznany'} (${r.targetVillageLabel})</span>
            <span class="rr-value">${timeLabel}</span>
        </summary>`;

        let body;
        if (r.type === 'recon') {
            const isViewerAttacker = me === r.attackerName;
            const note = r.success
                ? (isViewerAttacker
                    ? `Zwiad udany. Wysłano ${formatNumber(r.scoutsSent)}, schwytano ${formatNumber(r.scoutsLost)}, wróciło ${formatNumber(r.scoutsSurvived)}.`
                    : 'Twoja wioska została zwiadowana przez wroga.')
                : `Zwiadowcy schwytani — misja nieudana (stracono ${formatNumber(r.scoutsLost)}).`;
            const intel = (r.success && isViewerAttacker && r.intel) ? `
                <div class="row-sub" style="margin-top:6px;"><strong>Budynki:</strong> ${r.intel.buildings.map((b) => `${b.label} ${b.level}/${b.maxLevel}`).join(', ')}</div>
                <div class="row-sub"><strong>Garnizon:</strong> ${UNIT_DEFS.map((u) => `${u.label}: ${formatNumber(r.intel.garrison[u.id] || 0)}`).join(', ')}</div>
            ` : '';
            body = `<p class="row-sub">${note}</p>${intel}`;
        } else {
            const attackers = Array.isArray(r.attackers) ? r.attackers : [];
            const defenders = Array.isArray(r.defenders) ? r.defenders : [];
            const garrisonBefore = Array.isArray(r.defenderGarrisonBeforeBattle) ? r.defenderGarrisonBeforeBattle : null;
            const attackerRows = attackers.map((u) => `<div class="round-result-row"><span class="rr-name">${u.label}</span><span class="rr-value">wysłano ${formatNumber(u.sent)}${u.lost > 0 ? `, stracono ${formatNumber(u.lost)}` : ''}</span></div>`).join('') || '<p class="hint-text">Brak danych.</p>';
            let defenderRows;
            if (viewerWon && garrisonBefore && garrisonBefore.length) {
                defenderRows = garrisonBefore.map((u) => {
                    const lost = Number(defenders.find((d) => d.label === u.label)?.lost) || 0;
                    return `<div class="round-result-row"><span class="rr-name">${u.label}</span><span class="rr-value">stan ${formatNumber(u.count)}${lost > 0 ? `, stracono ${formatNumber(lost)}` : ''}</span></div>`;
                }).join('');
            } else {
                defenderRows = defenders.length
                    ? defenders.map((u) => `<div class="round-result-row"><span class="rr-name">${u.label}</span><span class="rr-value">${u.lost > 0 ? `stracono ${formatNumber(u.lost)}` : '—'}</span></div>`).join('')
                    : '<p class="hint-text">Brak obrońców.</p>';
            }
            let extraNote = '';
            if (r.capturedVillage) extraNote = `<p class="row-sub">⚔️ Lord przejął wioskę!${r.lordLoyaltyDamageDealt > 0 ? ` (-${formatNumber(r.lordLoyaltyDamageDealt)} lojalności)` : ''}</p>`;
            else if (Number(r.lordLoyaltyDamageDealt) > 0) extraNote = `<p class="row-sub">⚔️ Lord obniżył lojalność o ${formatNumber(r.lordLoyaltyDamageDealt)}.</p>`;
            body = `${extraNote}
                <p class="row-sub"><strong>Wojska atakujące</strong></p>${attackerRows}
                <p class="row-sub" style="margin-top:6px;"><strong>Wojska broniące</strong></p>${defenderRows}
                <p class="row-sub" style="margin-top:6px;">Straty — agresor: ${formatNumber(r.attackerLosses)} · obrońca: ${formatNumber(r.defenderLosses)}</p>`;
        }
        return `<details class="panel-card" style="margin-bottom:8px;">${summary}<div style="margin-top:8px;">${body}</div></details>`;
    }

    // ---------------- helpers ----------------
    function countdownText(endTimeMs) {
        if (!endTimeMs) return '';
        const remain = endTimeMs - Date.now();
        if (remain <= 0) return 'gotowe';
        return 'za ' + formatDuration(remain);
    }
    function formatDuration(ms) {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return (h > 0 ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
    }
    function formatNumber(value) {
        return Number(value || 0).toLocaleString('pl-PL');
    }

    // ---------------- KONIEC RUNDY: odliczanie + wyniki ----------------
    function showRoundEndingOverlay(seconds) {
        if (roundFinishedShown) return;
        $('roundEndingOverlay').classList.add('active');
        let remaining = seconds;
        $('roundEndingCountdown').textContent = remaining;
        clearInterval(roundEndingInterval);
        roundEndingInterval = setInterval(() => {
            remaining -= 1;
            $('roundEndingCountdown').textContent = Math.max(0, remaining);
            if (remaining <= 0) clearInterval(roundEndingInterval);
        }, 1000);
    }
    function hideRoundEndingOverlay() {
        clearInterval(roundEndingInterval);
        $('roundEndingOverlay').classList.remove('active');
    }

    // Mirrors public/game.js's renderRoundResults() — same source data (state.players/prizeResults/
    // mapType), just rendered as simple stacked rows instead of tables to fit a phone screen. Prize
    // breakdown (Mini-Turniej/Final) comes straight from the server, never re-derived here, since the
    // Final's real payout placement uses a different tie-break rule than a naive points sort would.
    function renderRoundResults() {
        if (!gameState) return;
        const prizeResults = Array.isArray(gameState.prizeResults) ? gameState.prizeResults : [];
        $('prizeResultsBlock').style.display = prizeResults.length ? 'block' : 'none';
        if (prizeResults.length) {
            const ordered = [...prizeResults].sort((a, b) => a.placement - b.placement);
            $('prizeResultsList').innerHTML = ordered.map((p) => `
                <div class="round-result-row"><span class="rr-place">${p.placement}</span><span class="rr-name">${p.username}</span><span class="rr-value">${formatNumber(p.vplnAwarded)} VPLN</span></div>
            `).join('');
        }

        const players = (gameState.players || []).map((p) => ({ ...p, points: Number(p.points) || 0, killsAsAttacker: Number(p.killsAsAttacker) || 0 }));
        const rankedByPoints = [...players].sort((a, b) => (window.GameEngine ? GameEngine.comparePlayersByRank(a, b) : b.points - a.points) || b.killsAsAttacker - a.killsAsAttacker).slice(0, 3);
        const rankedByKills = [...players].sort((a, b) => b.killsAsAttacker - a.killsAsAttacker || (window.GameEngine ? GameEngine.comparePlayersByRank(a, b) : 0)).slice(0, 3);
        $('pointsResultsList').innerHTML = rankedByPoints.map((p, i) => `
            <div class="round-result-row"><span class="rr-place">${i + 1}</span><span class="rr-name">${p.name}</span><span class="rr-value">${formatNumber(p.points)} pkt</span></div>
        `).join('');
        $('killsResultsList').innerHTML = rankedByKills.map((p, i) => `
            <div class="round-result-row"><span class="rr-place">${i + 1}</span><span class="rr-name">${p.name}</span><span class="rr-value">${formatNumber(p.killsAsAttacker)}</span></div>
        `).join('');

        const isTeamMode = gameState.mapType === 'team';
        $('teamResultsBlock').style.display = isTeamMode ? 'block' : 'none';
        if (isTeamMode) {
            const byTeam = new Map();
            players.forEach((p) => {
                if (p.teamId == null) return;
                if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, { teamId: p.teamId, color: p.color, totalPoints: 0, earliestAt: Infinity });
                const t = byTeam.get(p.teamId);
                t.totalPoints += p.points;
                const at = Number(p.pointsAchievedAt) || Infinity;
                if (at < t.earliestAt) t.earliestAt = at;
            });
            const teams = [...byTeam.values()].sort((a, b) => b.totalPoints - a.totalPoints || a.earliestAt - b.earliestAt);
            $('teamResultsList').innerHTML = teams.map((t, i) => `
                <div class="round-result-row"><span class="rr-place">${i + 1}</span><span class="rr-name" style="color:${t.color || '#94a3b8'};">Drużyna ${t.teamId}</span><span class="rr-value">${formatNumber(t.totalPoints)} pkt</span></div>
            `).join('');
        }
    }

    function showRoundResults() {
        hideRoundEndingOverlay();
        if (roundFinishedShown) return;
        roundFinishedShown = true;
        renderRoundResults();
        $('roundResultModal').classList.add('active');
    }

    $('btnCloseRoundResults').addEventListener('click', () => {
        $('roundResultModal').classList.remove('active');
        if (socket) { socket.disconnect(); socket = null; }
        gameState = null;
        showMenuScreen();
    });

    // Refresh countdowns/timers every second without waiting for a new game:state push, mirroring
    // public/game.js's patchBuildQueueCountdowns — purely a local re-render of already-known
    // timestamps, no extra network traffic.
    // Same isEditingQuantityInput() guard as applyState() above — this local 1s tick exists only to
    // refresh on-screen countdown text, and must never fire while the player has a quantity field
    // focused (see that function's comment for why: rebuilding a focused input dismisses the
    // on-screen keyboard on a real phone).
    setInterval(() => { if (gameState && !isEditingQuantityInput()) renderActiveTab(); }, 1000);

    // ---------------- boot ----------------
    if (authToken) {
        fetchMyProfile().then(resumeOrShowMenu);
    }
})();
