# Perang Strategi - Server (Railway)

Deploy:
1. Push folder ini ke repo GitHub (mis. `war-server`).
2. Railway -> New Project -> Deploy from GitHub repo -> pilih repo itu.
3. Tab Settings -> Networking -> Generate Domain. Catat domainnya.
4. (Opsional) Variables: MAX_ROOMS (default 6), LOBBY_WAIT_MS (default 15000), TICK_HZ (20).
5. Cek: buka https://DOMAIN-KAMU/health  -> harus muncul {"ok":true,...}

Client memakai alamat: wss://DOMAIN-KAMU  (wss, bukan https)
