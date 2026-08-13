# Numbers & Units

## 1. File Size

- Units: KB, MB, GB (always uppercase). Never use K, M, G or Kb, Mb, Gb.
- Two decimal places when there is a decimal: `1.40 MB`
- No decimals when whole number: `1 MB`
- Space between number and unit: `1.40 MB` (not `1.40MB`)
- Space before/after separator `/`: `1.40 MB / 41.12 MB`

## 2. Time

### Preferred Format (UI)

Use ISO 8601: `2018-03-18 12:03:45`

Alternative long format (text only, ample UI space): `2018年3月18日`

English: `March 18, 2018`

### Timestamp Display Rules

| Condition | Chinese | English |
|-----------|---------|---------|
| < 60 seconds | 刚刚 | Just now |
| < 60 minutes | xx 分钟前 | xx minutes ago |
| Same day | 14:30 | 14:30 |
| Yesterday | 昨天 14:30 | Yesterday 14:30 |
| Day before yesterday | 前天 14:30 | 2 days ago 14:30 |
| Within this week | 星期一 14:30 | Monday 14:30 |
| > 7 days, same year | 10月21日 14:30 | October 21st 14:30 |
| > 7 days, different year | 2024年10月21日 14:30 | October 21st, 2024 14:30 |

### Time Format

- **12-hour**: `上午 8:00` (no leading zero)
- **24-hour**: `08:00` (with leading zero)

## 3. Distance / Location

- Units: m, km (lowercase). Never use M or KM.
- Display as integer without decimals.
- Example: `100 米` / `235 公里`

## 4. Currency

### General Rules

- Negative amounts: sign follows number. `¥-10.00`
- Below 6 digits: no thousand separator. `¥2326.01`
- 6 digits or more: use half-width comma. `¥662,326.01`

### Currency Symbols (top-left in large-amount format)

| Symbol | Currency |
|--------|----------|
| ¥ | CNY (人民币) |
| $ | USD (美元) |
| € | EUR (欧元) |
| £ | GBP (英镑) |
| ₩ | KRW (韩元) |
| ฿ | THB (泰铢) |
| ₫ | VND (越南盾) |
| ₭ | LAK (老挝基普) |
| ₱ | PHP (菲律宾比索) |
| ₹ | INR (印度卢比) |
| ₽ | RUB (俄罗斯卢布) |
| ₪ | ILS (以色列新谢克尔) |
| ₺ | TRY (土耳其里拉) |
| ₮ | MNT (蒙古图格里克) |
| ₸ | KZT (哈萨克斯坦腾格) |
| ₲ | PYG (巴拉圭瓜拉尼) |
| ₴ | UAH (乌克兰格里夫纳) |
| ₵ | GHS (加纳赛地) |
| ₡ | CRC (哥斯达黎加科朗) |
| ₾ | GEL (格鲁吉亚拉里) |
| ₼ | AZN (阿塞拜疆马纳特) |
| ₦ | NGN (尼日利亚奈拉) |
| ¤ | Generic currency |

### ISO Codes

| Code | Currency |
|------|----------|
| GBP | 英镑 |
| HKD | 港币 |
| USD | 美元 |
| JPY | 日元 |
| CAD | 加拿大元 |
| AUD | 澳大利亚元 |
| EUR | 欧元 |
| NZD | 新西兰元 |
| KRW | 韩元 |
| THB | 泰铢 |
| SGD | 新加坡元 |
| RUB | 卢布 |

For CNY, USD, CAD, AUD, NZD, SGD, HKD in large-amount format, use the single HanYi character symbol in top-left.
