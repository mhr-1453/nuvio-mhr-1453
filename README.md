# Nuvio Eklenti Deposu

Nuvio uygulaması için Türkçe anime eklenti deposu. İlk eklenti: **AnimeciX** (animecix.tv).

## Kurulum

1. Nuvio uygulamasını açın.
2. **Settings → Content & Discovery → Plugins** (veya NuvioTV'de **Settings → Local Scrapers**) bölümüne gidin.
3. **Repository** alanına bu deponun `manifest.json` dosyasının ham (raw) GitHub adresini ekleyin:

   ```
   https://raw.githubusercontent.com/mhr-1453/nuvio-mhr-1453/refs/heads/main/manifest.json
   ```
4. Eklenti listede görünecektir; **AnimeciX** anahtarını açın.

## Eklenti: AnimeciX

| Alan | Değer |
| --- | --- |
| Kaynak site | https://animecix.tv |
| İçerik dili | Türkçe (altyazılı + dublaj) |
| Biçimler | MP4 (doğrudan), m3u8 |
| Desteklenen türler | movie, tv, anime |

### Nasıl çalışır?

- Nuvio size bir başlık açtığında eklenti TMDB/IMDB kimliğini alır, başlık adıyla
  AnimeciX araması yapar ve ad + yıl (±1 tolerans) ile eşleştirir.
- Bölümün kayıtlı **tüm** video kaynakları (`/secure/episode-videos-points`) çekilir ve
  her biri kendi çözücüsüyle doğrudan video adresine çevrilir:
  - **Tau Video** (birincil, doğrudan MP4 + kalite etiketleri)
  - **Sibnet, OK.ru, Dailymotion, Google Drive** (embed sayfasından medya adresi)
  - **Doodstream** (token + POST akışı)
  - **Uqload** (Dean Edwards packer çözücü + master m3u8 kaliteleri)
  - **Vidmoly** (JS yönlendirme zinciri + `file:` ayıklama)
  - **Streamtape** ve diğer HTML tabanlı host'lar (genel regex ayıklama)
- Çözülemeyen kaynaklar "embed" olarak listede kalır, kaybolmaz.
- AnimeciX API'si her istekte `x-e-h` başlığı ister: AES-256-GCM ile şifrelenmiş
  sorgu dizesi. Hermes'te Node crypto/WebCrypto bulunmadığı için eklenti içinde
  **saf JavaScript AES-256-GCM** uygulanmıştır (Node `crypto` ile byte-byte
  doğrulanmıştır).

### Sınırlamalar

- AnimeciX, Cloudflare altındadır; eklenti kullanıcı cihazındaki (ev IP'si) çalışır,
  ancak bazı durumlarda Cloudflare istekte bulunabilir. Sunucu/datacenter IP'lerinden
  gelen istekler 403 ile engellenir — bu depo içindeki test ortamında da böyleydi.
- Altyazılar şimdilik eklenmemiştir (Nuvio akışlarına `subtitles: []` ile boş döner).

## Yeni eklenti ekleme

1. `providers/` altına yeni bir `<eklenti>.js` dosyası ekleyin.
2. Zorunlu dışa aktarım: `module.exports = { getStreams }`. İmza:

   ```javascript
   // id: TMDB id (sayı) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
   function getStreams(id, mediaType, season, episode) {
     return Promise.resolve([
       {
         name: '⌜ Eklenti ⌟ | Sunucu | 1080p',
         title: 'Başlık S1E1',
         url: 'https://.../video.mp4',
         quality: '1080p',
         size: '417.4 MB',
         headers: { 'User-Agent': '...', 'Referer': 'https://...' },
         subtitles: [],
       },
     ]);
   }
   ```

3. `manifest.json` içindeki `scrapers` dizisine yeni kaydı ekleyin
   (`id`, `name`, `description`, `version`, `author`, `supportedTypes`,
   `filename`, `formats`, `logo`, `contentLanguage` alanları).
4. **Önemli (Hermes):** Nuvio, eklentileri dinamik olarak yükler ve çalışma
   ortamı dinamik kodda `async/await` desteği vermez. Tüm eklentiler
   `Promise` zincirleriyle (`.then(...)`) ve ES5 tarzı fonksiyonlarla yazılmalıdır.

## Dosya yapısı

```
nuvio-mhr-1453/
├── manifest.json        # Depo kaydı (Nuvio'nun okuduğu dosya)
├── README.md
└── providers/
    └── animecix.js      # AnimeciX eklentisi (tek dosya, bağımlılıksız)
```

## Geliştirme ve test

Eklenti bağımsız tek dosyadır; Node.js ile hızlıca deneyebilirsiniz:

```bash
node -e "
const p = require('./providers/animecix.js');
p.getStreams(31910 /* TMDB: Naruto Shippuuden */, 'tv', 1, 1)
 .then(s => console.log(s.map(x => '[' + x.quality + '] ' + x.url)));
"
```

Not: Sunucu IP'sinden AnimeciX Cloudflare engeline takılabilir (403 + HTML sayfa);
gerçek cihaz/ev IP'sinde sorunsuz çalışır.
