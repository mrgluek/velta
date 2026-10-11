# Russian DNS resolvers — inventory for whitelist-mode networks (2026-10-11)

Desk research only. Every address below comes from a published source
(linked in the last column or in "Sources"); NONE was probed live — the
research sandbox intercepts all outbound port 53 (even `10.255.255.1`
"answers" NXDOMAIN), and a probe from outside Russia says nothing about
whitelist mode anyway. Run the probe script at the end from a Russian SIM
before relying on any row.

Already in use and not repeated in detail: Yandex DNS (`77.88.8.8`,
`77.88.8.1`, safe `77.88.8.88`/`77.88.8.2`, family `77.88.8.7`/`77.88.8.3`)
and MSK-IX DNS (`62.76.76.62`, `62.76.62.76`; IPv6 `2001:6d0:6d0::2001`,
`2001:6d0:d6::2001`).

Confidence: **A** = the operator's own docs, **B** = several independent
third-party sources, **C** = one forum post, an old page, or a lookup site.

## 1. What whitelist mode does to DNS (what reports say)

- It applies to mobile data only. Rostelecom and the Ministry of Digital
  Development (March 2026) say wired home internet is not affected.
- How it filters varies by operator and over time. One ntc.party report:
  SNI-based on MTS, MegaFon and Tele2, CIDR-based on Beeline. Later posts:
  "mobile is now a CIDR whitelist, not SNI".
- On Habr, UDP:53 to foreign resolvers is typically NO_RESP; the
  operator's own resolver keeps answering.
- Field reports, one region each:
  - Tele2 St Petersburg: the operator DNS, Yandex and the NSDI recursive
    resolver answer; MSK-IX does not.
  - MegaFon Krasnodar: Yandex was the only DNS that answered.
  - Another report: only the provider's DNS answered on udp/53; NSDI and
    MSK-IX did not.
  - dnstt ran "surprisingly well" through NSDI `195.208.4.1`. Provider and
    Yandex resolvers are often rate-limited.
  - Rostelecom's own resolvers "work fine", but not through Beeline base
    stations, where only `8.8.8.8` answered.
- Practical order of preference on a whitelisted SIM: the
  operator-assigned DNS (PDP/DHCP) → Yandex → NSDI → the Rostelecom
  resolvers → everything else.

## 2. Public resolvers in Russia (open recursion)

| Service | IPv4 | IPv6 / encrypted | Conf. | Notes |
|---|---|---|---|---|
| NSDI (National Domain Name System, AS41740, run on MSK-IX infra) | `195.208.4.1`, `195.208.5.1` | `2a0c:a9c7:8::1`, `2a0c:a9c7:9::1`; names `a.res-nsdi.ru`, `b.res-nsdi.ru` | B | Anycast. Does not resolve RKN-blocked domains. Seen working in whitelist mode on Tele2 SPb; dnstt-friendly. Best non-Yandex candidate. |
| SkyDNS (Yekaterinburg) | `193.58.251.251` | DoH `https://doh.skydns.ru/` | A | Content filter. Unregistered clients get the default filter policy. |
| SafeDNS | `195.46.39.39`, `195.46.39.40` | — | A | Of Russian origin. Documentation is in English; whether the nodes are in Russia is not confirmed. |
| Comss.one DNS | `83.220.169.155`, `212.109.195.93`; routers: `195.133.25.16` | DoH `https://dns.comss.one/dns-query`, DoT/DoQ `dns.comss.one` | B | Smart-DNS proxy. Known for outages and changing IPs (4PDA). |
| Xbox DNS (xbox-dns.ru) | `111.88.96.54`, `111.88.96.55` | `2a00:ab00:1233:26::50`, `::51`; DoH `https://xbox-dns.ru/dns-query` | B | Smart-DNS proxy with legal issues (SecurityLab). Outdated addresses: `176.99.11.77`, `80.78.247.254`. |
| Rostelecom, listed as open | `83.171.107.214`, `92.124.144.189` | — | C | AS12389, from a public DNS directory (dnsspy). Likely CPE or regional resolvers; they come and go. |

## 3. Operator resolvers (usually subscriber-only)

Operator resolvers normally refuse recursion to outsiders. Use them on that
operator's own SIM, where whitelist mode leaves them reachable. The one
operator DNS that is guaranteed is the one the PDP session hands out;
read it from the device (Android: Wi-Fi/SIM details or `getprop
net.dns1` on root; modem: `ipconfig /all`).

### Rostelecom (AS12389)

| IPv4 | Conf. | Source / notes |
|---|---|---|
| `82.208.90.3` | C | The user's example. It sits in `82.208.64.0/18`, which is registered to PJSC Rostelecom (networksdb). No published reference to the address was found. |
| `213.158.0.6` | C | Several unofficial Rostelecom how-to sites; "regional/auxiliary". |
| `212.48.193.36` | C | Same sites. One of them writes it as `213.48.193.36`. |

Rostelecom's resolvers are a good bet in whitelist mode. Rostelecom is a
whitelist operator itself, and one report says its own DNS keeps working.

### MTS (AS8359; mobile AS3216 legacy)

Official MTS support page, "DNS for wired business internet" (A). These
are business wired resolvers, not documented for mobile.

| IPv4 | Region per page |
|---|---|
| `213.87.2.88`, `213.87.2.89` | Moscow/MO (search snippets also tie them to N. Novgorod and Kazan) |
| `213.87.74.21`, `213.87.74.5` | regional |
| `213.87.99.120`, `213.87.99.100` | Far East regions |
| `195.34.32.116`, `212.188.4.10` | Belgorod |

Unconfirmed folklore: mobile `213.87.0.1` and `213.87.1.1` (no source
found).

### Beeline (VimpelCom, AS3216 / AS8402)

| IPv4 | Conf. | Notes |
|---|---|---|
| `217.118.66.243`, `217.118.66.244` | C | Old Beeline GPRS settings page (phdru.name). |
| `194.67.2.114`, `194.67.1.154` | A | Beeline Business news: new DNS servers "from 01.04.2014" (Voronezh page). |
| `217.118.93.16` | C | A mobile resolver seen in the wild (vc.ru, BEE-AS). |

### MegaFon / Yota (AS31133, AS25159)

| IPv4 | Conf. | Notes |
|---|---|---|
| `178.176.63.46` | C | Lookup site: "MegaFon public DNS", Moscow pool `MF-MOSCOW-BBA-POOL-178-176-0-0`. |
| `217.150.34.129`, `217.150.35.129` | C | 2004 forum post; probably dead. |

MegaFon says DNS is assigned per region automatically and publishes no
list. The mobile network is NAT64/DNS64-heavy (forum reports of IPv6
DNS answers). In whitelist mode on MegaFon Krasnodar, Yandex was the only
resolver that answered.

### Tele2 / T2 (AS15378, AS12958 legacy)

No published resolver list. In whitelist mode on Tele2 SPb, the
operator DNS, Yandex and NSDI answered and MSK-IX did not.

## 4. Hosting-provider resolvers (customers only)

Selectel publishes recursive DNS for its cloud subnets, and they are set up
automatically there (docs.selectel.ru "dns-recursive-servers-list").
The addresses could not be fetched. Recollection says `188.93.16.19`,
`188.93.17.19` and `109.234.159.91`, which is UNVERIFIED. Timeweb and VK
Cloud publish no public resolvers.

## 5. Probe script (run from a Russian SIM, with and without whitelist mode)

```bash
#!/usr/bin/env bash
# usage: ./probe.sh [name]   — needs dig (bind9-dnsutils) or kdig
name=${1:-ya.ru}
for ip in \
  77.88.8.8 77.88.8.1 62.76.76.62 62.76.62.76 195.208.4.1 195.208.5.1 \
  193.58.251.251 195.46.39.39 195.46.39.40 83.220.169.155 212.109.195.93 \
  195.133.25.16 111.88.96.54 111.88.96.55 83.171.107.214 92.124.144.189 \
  82.208.90.3 213.158.0.6 212.48.193.36 \
  213.87.2.88 213.87.2.89 213.87.74.21 213.87.74.5 213.87.99.120 \
  213.87.99.100 195.34.32.116 212.188.4.10 213.87.0.1 213.87.1.1 \
  217.118.66.243 217.118.66.244 194.67.2.114 194.67.1.154 217.118.93.16 \
  178.176.63.46 217.150.34.129 217.150.35.129 \
  8.8.8.8 1.1.1.1; do
  r=$(dig +time=2 +tries=1 +short @"$ip" "$name" A 2>&1 | head -1)
  printf '%-16s %s\n' "$ip" "${r:-NO ANSWER}"
done
```

Read the results this way:
- An IP back means it answers and recurses for you.
- `NO ANSWER`/timeout means the address is dropped, either by whitelist
  mode or because the resolver is closed.
- `REFUSED` (seen with `dig` without `+short`) means it is reachable but
  does not recurse for outsiders.

Run it twice: once with a whitelisted name (`ya.ru`) and once with a
non-whitelisted one. That shows whether the filter acts on DNS or only on
IP/SNI.

## 6. Relevance to Velta

The core resolves through the system resolver plus its own `dns_cache`
(`core/src/net/dns.rs`). In the wasm PWA it resolves through the relay's
`/dns/<host>` endpoint (§4.2.1 of AGENTS.md). A working resolver alone
does not get mail through in whitelist mode: the relay's IP/SNI must be
reachable too. On CIDR-whitelist operators that means the relay has to
sit in an allowed range, not just resolve.

## Sources

- [List of Top Public Recursive Name Servers (gist, RU rows: Yandex, MSK-IX, NSDI)](https://gist.github.com/mutin-sa/5dcbd35ee436eb629db7872581093bc5)
- [Habr: NSDI resolvers as upstream (2021)](https://habr.com/ru/post/579634)
- [ntc.party: DNStt as a whitelist bypass (NSDI, Yandex, Tele2 SPb report)](https://ntc.party/t/dnstt-%D0%BA%D0%B0%D0%BA-%D1%81%D0%BF%D0%BE%D1%81%D0%BE%D0%B1-%D0%BE%D0%B1%D1%85%D0%BE%D0%B4%D0%B0-%D0%B1%D0%B5%D0%BB%D1%8B%D1%85-%D1%81%D0%BF%D0%B8%D1%81%D0%BA%D0%BE%D0%B2-%D0%BF%D0%B0%D1%80%D0%B0-%D0%B2%D0%BE%D0%BF%D1%80%D0%BE%D1%81%D0%BE%D0%B2/20212)
- [ntc.party: Bypassing whitelists (theory)](https://ntc.party/t/%D0%BE%D0%B1%D1%85%D0%BE%D0%B4-%D0%B1%D0%B5%D0%BB%D1%8B%D1%85-%D1%81%D0%BF%D0%B8%D1%81%D0%BA%D0%BE%D0%B2-%D1%82%D0%B5%D0%BE%D1%80%D0%B8%D1%8F/19123)
- [ntc.party: Whitelists / what to do (Rostelecom DNS, Beeline BS)](https://ntc.party/t/%D0%B1%D0%B5%D0%BB%D1%8B%D0%B5-%D1%81%D0%BF%D0%B8%D1%81%D0%BA%D0%B8-%D1%87%D0%B5-%D0%B4%D0%B5%D0%BB%D0%B0%D1%82%D1%8C/23468)
- [Habr: everything about whitelists + 6 bypasses (UDP:53 NO_RESP)](https://habr.com/ru/articles/1027276/)
- [net4people/bbs #650: bypassing RU mobile whitelists](https://github.com/net4people/bbs/issues/650)
- [iXBT: whitelists are mobile-only (Rostelecom, 2026-03-31)](https://www.ixbt.com/news/2026/03/31/belye-spiski--tolko-dlja-mobilnogo-interneta-rostelekom-oproverg-soobshenija-o-vozmozhnyh-ogranichenijah-domashnego.html)
- [SkyDNS docs](https://docs.skydns.ru/books/ustanovka-i-nastroika-filtracii/page/poryadok-nastroiki-routera-mikrotik/export/pdf)
- [SafeDNS docs](https://docs.safedns.com/books/installation-guides/page/mac-dns-setup/export/plaintext)
- [Comss.one DNS](https://www.comss.ru/page.php?id=7315)
- [Xbox DNS](https://xbox-dns.ru/) · [SecurityLab on Xbox DNS](https://www.securitylab.ru/blog/personal/Bitshield/362911.php)
- [MTS: DNS for wired business internet](https://support.mts.ru/mts_fiksirovannaya_svyaz/nastroika-i-diagnostika-provodnogo-interneta-ili-telefonii-dlya-biznesa/adres-dns-dlya-nastroiki-provodnogo-biznes-interneta)
- [Beeline Business: new DNS servers](https://voronezh.beeline.ru/business/news/0cbbe35b-1cad-4eb8-9045-d5ee17a262e0/) · [Beeline GPRS settings](https://phdru.name/Russian/cellphones/Beeline.html) · [vc.ru: Beeline DNS error](https://vc.ru/u/1161799-pleomaxtor/450901-bilayn-i-oshibka-dns)
- [ipshu: 178.176.63.46 (MegaFon)](https://en.ipshu.com/dns-ip/178.176.63.46) · [Yota/MegaFon FAQ](https://spb.megafon.ru/corporate/help/faq/yota/internet/problems)
- [Rostelecom DNS how-to (213.158.0.6, 212.48.193.36)](https://kakoperator.ru/operators/dns-servery-rostelekom-i-ih-adresa)
- [networksdb: PJSC Rostelecom networks (82.208.64.0/18)](https://networksdb.io/ip-addresses-of/pjsc-rostelecom)
- [dnsspy: Russian Federation public DNS](https://dnsspy.io/dns-tools/public-dns-servers-list/russian-federation)
- [Selectel: about DNS (recursive servers)](https://docs.selectel.ru/en/infrastructure/dns/about-dns/)
