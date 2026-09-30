# 上游缺陷：`m3u8-rs` 的 `EXT-X-KEY` 校验有误，导致含 `METHOD=NONE` 的 HLS 流无法下载

**状态**：已在 `m3u8-rs 6.0.1`（= 截至 2026-09-30 的最新版）复现并定位；**master 分支至今未修复**。
FluxDown `native/engine` 依赖 `m3u8-rs = "6"`。
**影响**：FluxDown 无法下载任何「同一 media playlist 内 AES-128 段之后跟 `#EXT-X-KEY:METHOD=NONE` 明文段」的流。
**责任层**：`m3u8-rs`（上游）→ FluxDown 引擎。**与本插件无关**，插件层无法规避。

> ✅ **已向上游提交 PR**：[rutgersc/m3u8-rs#95](https://github.com/rutgersc/m3u8-rs/pull/95)
> "playlist: Don't drop EXT-X-KEY when METHOD=NONE"
>
> | 项 | 值 |
> |---|---|
> | fork / 分支 | `cocolight/m3u8-rs` · **`fix/ext-x-key-method-none`** |
> | 提交 | `35bab65`（基线 `8df664c` = upstream/master；代码内容与首推的 `99a5836` 逐字节相同，仅 commit message 修正措辞后 amend） |
> | 改动 | 1 file / **+36 / −3** —— 3 行修复 + 2 个回归测试 |
> | 状态 | **OPEN · MERGEABLE · CLEAN**，CI `build ×2` **pass**（19s / 54s），提交于 2026-09-30 14:11 CST |
> | 补丁 | [`upstream-m3u8-rs-method-none.patch`](./upstream-m3u8-rs-method-none.patch)（与提交逐字节一致） |
> | 已废弃 | 草稿 PR #94（分支 `fix/lenient-ext-x-key-attributes`，提交 `18eb48b`，+72 / −22 的 `take_attr` 重构写法）—— 因非最小修改，已于 2026-09-30 13:10 CST 由作者主动关闭；写法留档于 §4.2b |
>
> **改法定稿为「最小修改」—— 只删那条写反的守卫**（§4.2）。
> 曾实现并实测过的「纯提取」方案保留在 §4.2b，**未采用**；取舍依据见 §4.1 / §4.6。
> 定稿原则：保证健壮的前提下取最小改动；一个 PR 只解决一个问题。

> **上游此前已有一次失败的尝试**：PR [rutgersc/m3u8-rs#76](https://github.com/rutgersc/m3u8-rs/pull/76)
> "fix: EXT-X-KEY: METHOD=NONE parsing error"（2024-09-27 开，维护者至今**零回应**，open ≈ 2 年）。
> ⚠️ **#76 的改法是错的** —— 它只把条件翻转，会**新破坏**「`METHOD=AES-128` 无 IV」这一
> RFC 合法且当前可用的形态。详见 §4。**#95 未采用该写法**，并配有守护测试。

---

## 1. 现象

```
URL   : https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8
失败  : decrypt_segment: segment 5 PKCS7 decrypt error (likely wrong key/IV): Unpad Error
```

该流是**完全合法、且可正常解密**的流 —— 不是 DRM，不是坏源。用 `openssl` 手工解密可完全还原：

| 分片 | key | 明文首字节 | 末 16 字节（PKCS7） | 结论 |
|---|---|---|---|---|
| seg1 `1041_6_1822767.ts` | key1 | `0x47` | —（下载被 CDN 截断，不作数） | — |
| seg2 `1041_6_1822768.ts` | key2 | `0x47` | `…ffff04040404` | pad=4 ✓ |
| seg3 `1041_6_1822769.ts` | key3 | `0x47` | `…1010101010101010` | pad=16 ✓ |
| seg4 `1041_6_1822770.ts` | key4 | `0x47` | `…ffff08080808080808` | pad=8 ✓ |

首字节均为 `0x47`（MPEG-TS 同步字节），PKCS7 填充全部合法 → **key/IV 正确、填充规范**。

## 2. 最小复现（Rust，约 20 行）

```toml
# Cargo.toml
[package]
name = "m3u8test"
version = "0.0.0"
edition = "2021"

[dependencies]
m3u8-rs = "6"        # FluxDown 解析到的 6.0.1
[workspace]
```

```rust
// src/main.rs —— 读入该流，打印每段的 key
use m3u8_rs::Playlist;
fn main() {
    let data = std::fs::read("dai_manifest.m3u8").unwrap();
    if let Ok((_r, Playlist::MediaPlaylist(pl))) = m3u8_rs::parse_playlist(&data) {
        for (i, s) in pl.segments.iter().enumerate() {
            println!("seg[{:>2}] key={:?} uri={} unknown={:?}",
                     i, s.key.as_ref().map(|k| &k.method), s.uri, s.unknown_tags);
        }
    }
}
```

实际输出（节选）：

```
seg[ 3] key=Some(AES128) uri=1041_6_1822770.ts?m=1506045858          unknown=[]
seg[ 4] key=None         uri=u-6400-m-720x408-1628-a-96-1-1.ts       unknown=[ExtTag { tag: "X-KEY", rest: Some("METHOD=NONE") }]
seg[ 5] key=None         uri=u-6400-m-720x408-1628-a-96-1-2.ts       unknown=[]
...
seg[24] key=Some(AES128) uri=1041_6_1822791.ts?m=1506045858          unknown=[]
```

**关键**：`#EXT-X-KEY:METHOD=NONE` 没有变成 `key=Some(None)`，而是被**降级成未知标签**（`X-KEY` / `METHOD=NONE`）并塞进 `unknown_tags`，该段的 `key` 是 **`None`**。

## 3. 根因链

### 3.1 `m3u8-rs` 的 `EXT-X-KEY` 校验：属性错、条件反、前提假

`src/playlist.rs` → `impl Key::from_hashmap`：

```rust
let iv = unquoted_string!(attrs, "IV");
if method == KeyMethod::None && iv.is_none() {
    return Err("IV is required unless METHOD is NONE".parse().unwrap());
}
```

**这里有三个独立的错误，叠在一起：**

1. **属性搞错了**：RFC 8216 §4.3.2.4 里 "REQUIRED unless the METHOD is NONE" 这句是给 **`URI`** 的：
   > `URI` — ... This attribute is REQUIRED unless the METHOD is NONE.

   报错文本 `"IV is required unless METHOD is NONE"` 是把 RFC 的 `URI` 句子抄成 `IV` 的**误植**。
2. **条件写反了**：即便按它自己的措辞，也应是 `method != None && iv.is_none()`；实际写成 `==`。
3. **前提本身不成立**：**IV 从来就不是必需属性**。RFC 8216 §4.3.2.4 对 IV 的措辞里没有 REQUIRED，
   §5.2 明确：
   > An EXT-X-KEY tag with a KEYFORMAT of "identity" that does not have an IV attribute indicates
   > that the Media Sequence Number is to be used as the IV ...

所以这条校验**不约束任何合法输入** —— 它唯一的效果就是让 `METHOD=NONE`（唯一合法形态 = 无 IV）必然失败。

**为什么它能潜伏至今**：`METHOD=NONE` 按 RFC 是 *MUST NOT* 携带其他属性，但现实中有打包器会写成
`METHOD=NONE,IV=0x…` —— 而那种形态因为「带了 IV」**恰好绕过了这条写反的守卫**（见 §4.1 用例 02）。
只有严格遵守 RFC 的流才会踩到。

于是 `METHOD=NONE` 解析失败 → `map_res(key_value_pairs, Key::from_hashmap)` 失败 →
`media_segment_tag` 的 `alt` 落到 `ext_tag` 分支 → 变成 `SegmentTag::Unknown`。

**"能写出、读不回" 的铁证**（同一文件 `src/playlist.rs`）：

```rust
impl FromStr for KeyMethod {                       // 能解析 "NONE"
    "NONE" => Ok(KeyMethod::None), ...
}
impl Display for KeyMethod {                       // 能输出 "NONE"
    KeyMethod::None => "NONE", ...
}
impl Default for KeyMethod { fn default() -> Self { KeyMethod::None } }   // 默认值就是它
```

一个库能构造、能序列化、还能作为 `Default` 的枚举变体，却**无法从它自己的输出反序列化回来** ——
这是 round-trip 不闭合，标准意义上的 bug。该 crate 内**没有任何 `METHOD=NONE` 的测试用例**
（`grep -r "METHOD=NONE"` 零命中），所以长期未被发现。

### 3.2 FluxDown 的粘性密钥因此不重置

`native/engine/src/hls_downloader.rs`（解析段）：

```rust
if let Some(key) = &seg.key {            // ← METHOD=NONE 的段 seg.key 是 None，整个块被跳过
    current_key = match &key.method {
        &m3u8_rs::KeyMethod::AES128 => Some(HlsKey { method: Aes128, .. }),
        &m3u8_rs::KeyMethod::None  => Some(HlsKey { method: None, .. }),   // ← 死代码，永不触发
        other => return Err(DownloadError::Other(format!(
            "unsupported HLS encryption method: {:?}", other))),
    };
}
```

`KeyMethod::None` 那个分支是**死代码**（作者注释也误以为 m3u8-rs 会发出该标签）。`current_key` 停留在上一段的 `key4`，随后：

```rust
let seg_key = current_key.as_ref().and_then(|k| {
    if k.method == HlsKeyMethod::Aes128 { Some(HlsKey { .. }) } else { None }
});
```

明文段拿到 `Some(key4)` + `IV=…1BD032` → 被强行 AES-128-CBC 解密 → 末字节随机 → **PKCS7 unpad 失败 → `Unpad Error`**。

### 3.3 为什么报的段号会变（`segment 5` / `segment 4` 都见过）

写盘器遇到**任意**一个失败结果就立即中止，不等待最小索引：

```rust
Some((idx, Err(e))) => {                  // 谁先回传就报谁
    log_info!("[hls-download] task {} segment {} failed: {}", p.task_id, idx, e);
    p.cancel_token.cancel();
    fatal_error = Some(e);
    break 'writer;
}
```

并发 16 时索引 4…23 全部失败，报哪个纯看竞速 → 段号看起来随机。这是**诊断体验缺陷**（一次性报出全部失败索引更有用），但不影响本缺陷的定性。

## 4. 修复方案

### 4.1 四种改法的实测对比（本机打补丁跑出来的，非推断）

方法：从 crates.io 取 `m3u8-rs 6.0.1` 源码 vendored 进本地工程
（`[dependencies] m3u8-rs = { path = "../vendor/m3u8-rs-6.0.1" }`），分别施以四种改动，
对同一组 **13 个用例**跑 `parse_playlist`，断言两件事：`seg.key` 的表达力、是否发生「静默降级」。

> 「降级」= 整条标签落入 `unknown_tags`（`X-KEY`），该段 `key` 变成 **`None`** ——
> 而 `None` 在 HLS 语义里是「没有 KEY 标签 → 沿用上一段密钥」，与「显式明文」完全相反。

| # | 用例 | 上游原版 | PR #76 写法 | **仅删守卫（本方案）** | 纯提取（探索过，未采用） |
|---|---|---|---|---|---|
| 01 | `METHOD=NONE` 无 IV —— **RFC 合法，且是 NONE 唯一的合法形态** | ✗ 降级 | ✓ | ✓ | ✓ |
| 02 | `METHOD=NONE,IV=0x…` —— RFC 不合法，但现实常见 | ✓ | ✓ | ✓ | ✓ |
| 03 | `METHOD=NONE,URI="k"` —— RFC 不合法 | ✗ 降级 | ✓ | ✓ | ✓ |
| 04 | `METHOD=AES-128,URI="k"` 无 IV —— **RFC 合法（§5.2），下游引擎已专门适配** | ✓ | ✗ **降级** | ✓ | ✓ |
| 05 | `METHOD=AES-128` 无 URI —— 缺 REQUIRED 属性 | ✓ 放行 | ✗ **降级** | ✓ 放行 | ✓ 放行 |
| 06 | `IV="0x00"` 带引号 —— 类型不匹配 | ✗ 降级 | ✗ 降级 | ✗ 降级 | ✓ |
| 07 | 小写属性名 `method=` —— 违反 §4.2 属性名字符集 | ✗ 降级 | ✗ 降级 | ✗ 降级 | ✗ 降级 |
| 08 | `METHOD=SAMPLE-AES-CTR` —— 未知 METHOD | ✓ `Other(..)` | ✗ **降级** | ✓ | ✓ |
| 09 | `METHOD=SAMPLE-AES` + Widevine KEYFORMAT | ✓ | ✗ **降级** | ✓ | ✓ |
| 10 | 缺 `METHOD` —— REQUIRED 属性缺失 | ✗ 降级 | ✗ 降级 | ✗ 降级 | ✗ 降级 |
| 11 | `AES-128` → `NONE` 混合 —— **即触发本 issue 的 dai 流形态** | ✗ 第 2 段降级 | ✓ | ✓ | ✓ |
| 12 | `METHOD="AES-128"` 带引号 —— 类型不匹配 | ✗ 降级 | ✗ 降级 | ✗ 降级 | ✗ **降级** |
| 13 | `URI=k` 不带引号 —— 类型不匹配 | ✗ 降级 | ✗ 降级 | ✗ 降级 | ✓ |

四个结论：

1. **PR #76 净收益为负**：它把 01 / 03 修好，却把 **04 / 05 / 08 / 09** 从可用打成降级。
2. **其中 08 / 09 最危险**：`SAMPLE-AES` 与 DRM 流会从「能识别为加密、引擎明确拒绝」
   变成「看起来完全没加密」→ 引擎按明文下载 → **静默产出损坏文件**。这种"静默成功"比报错更糟。
3. **「纯提取」方案未能自洽**：它消除了 `URI`/`IV`/`KEYFORMAT*` 的引号宽容缺口，
   却把 `METHOD` 的同类缺口留在原地（用例 12）—— 与本 issue 是**同一类失败、同一级危害**
   （`Err` → `key = None` → 沿用上一段密钥）。要让「除 METHOD 缺失外必须产出 `SegmentTag::Key`」
   这条原则成立，必须连 `METHOD` 取值一起放宽。详见 §4.2b。
4. **「仅删那条守卫」（本方案，−3 行 / +0）**修好 01 / 03 / 11，
   **足以覆盖真实世界已观测到的全部形态**（现场证据只有 RFC 完美的 `METHOD=NONE`），
   且不改变任何其他输入的行为。代价是 06 / 12 / 13 仍静默降级 —— 但它们**零现场证据**。
   取舍见 §4.6。

### 4.2 采用方案：删掉那条写反的守卫（最小修改）

补丁：**[`upstream-m3u8-rs-method-none.patch`](./upstream-m3u8-rs-method-none.patch)**（2 个 hunk：3 行修复 + 2 个回归测试）

```diff
         let uri = quoted_string!(attrs, "URI");
         let iv = unquoted_string!(attrs, "IV");
-        if method == KeyMethod::None && iv.is_none() {
-            return Err("IV is required unless METHOD is NONE".parse().unwrap());
-        }
         let keyformat = quoted_string!(attrs, "KEYFORMAT");
```

就这些。选它的三个理由：

1. **回归风险为零** —— 只删掉一条已被证明写错的校验，不改变任何其他输入的行为。
   与之对比，「纯提取」会放宽 `IV` / `URI` / `KEYFORMAT*` 的取值类型（06 / 13 从降级变可用），
   那是**行为扩张**，需要单独论证。
2. **主张可验证** —— 不携带任何"零现场证据"的行为承诺。PR 里每一句都能被用例证实。
3. **过审摩擦最小** —— 3 行删除几乎无法被质疑。

附带（非目标）效果：`#EXT-X-KEY:METHOD=NONE,IV=0x…`（用例 02，RFC 不合法但现实常见）
从「原版放行」保持为「放行」，不受影响。

### 4.2b 备选（未采用）：让 `#EXT-X-KEY:` 永不降级

补丁形态为 3 个 hunk / `−22 / +72`。核心不是"删掉那条判断"，而是**换掉 URI / IV 的取值方式** ——
从「引号类型必须精确匹配，否则 `Err`」改为「两种形态都接受」：

```rust
impl Key {
    /// Accepts both quoted and unquoted attribute values.
    fn take_attr(attrs: &mut HashMap<String, QuotedOrUnquoted>, name: &str) -> Option<String> {
        attrs.remove(name).map(|v| match v {
            QuotedOrUnquoted::Quoted(s) => s,
            QuotedOrUnquoted::Unquoted(s) => s,
        })
    }

    pub(crate) fn from_hashmap(mut attrs: HashMap<String, QuotedOrUnquoted>) -> Result<Key, String> {
        let method: KeyMethod = unquoted_string_parse!(attrs, "METHOD")
            .ok_or_else(|| String::from("EXT-X-KEY without mandatory METHOD attribute"))?;

        // 不做存在性与形态校验 —— 此处返回 Err 会把整条标签静默降级（见 §4.3）
        let uri = Key::take_attr(&mut attrs, "URI");
        let iv = Key::take_attr(&mut attrs, "IV");
        let keyformat = Key::take_attr(&mut attrs, "KEYFORMAT");
        let keyformatversions = Key::take_attr(&mut attrs, "KEYFORMATVERSIONS");

        Ok(Key { method, uri, iv, keyformat, keyformatversions })
    }
}
```

三处改动：

1. `Key` 的 `URI` / `IV` / `KEYFORMAT` / `KEYFORMATVERSIONS` 改用宽容取值（消除 06 / 13 类降级）；
2. 删除那条写反的 IV 守卫（消除 01 / 03 类降级）；
3. `unquoted_string!` 宏随之成为死代码（它此前**只**被 `Key` 使用），一并删除，保持 warning-free。

`from_hashmap` 仍是 `pub(crate)`，**公开 API 无变化**。

**未采用的原因**：用例 12（`METHOD="AES-128"` 带引号）仍会降级 —— 方案只对 `URI`/`IV`/`KEYFORMAT*`
宽容，`METHOD` 的取值约束原样保留，**原则不自洽**。而这项放宽本身**零现场证据**
（真实世界观测到的失败只有 RFC 完美的 `METHOD=NONE` 一种形态），却把 diff 放大到最小修改的约 8 倍。
若将来要做，必须**同时**把 `METHOD` 也改为宽容取值（`take_attr` 取 `METHOD` 再 `parse`；
`KeyMethod::FromStr` 本就把任意字符串收进 `Other(s)`，接受带引号形式不引入新的宽松哲学），
否则文档与实测不符。该目标已列为**独立议题**（见 §4.6 末）。

**为什么不在 `from_hashmap` 里补一条正确的 URI 校验？** 见 §4.3。

### 4.3 为什么"加一条正确校验"反而更糟 —— 关键设计约束

`Key::from_hashmap` 的 `Err` 出口不是普通的"这次解析失败"，它连着一条静默降级链：

```rust
fn media_segment_tag(...) {                 // parser.rs
    alt((
        ...
        map(pair(tag("#EXT-X-KEY:"), key), |(_, key)| SegmentTag::Key(key)),
        //   key = map_res(key_value_pairs, Key::from_hashmap)
        //   ↑ 一旦 from_hashmap 返回 Err，nom 的 alt 会回溯（连 #EXT-X-KEY: 前缀一起回退）
        ...
        map(ext_tag, SegmentTag::Unknown),   // ← 兜底：整行变成 unknown_tags 里的一条 X-KEY
    ))(i)
}
```

后果不是"这一次没解析出来"，而是：

- `seg.key` 从 `Some(Key{…})` 变成 **`None`**；
- ⚠️ **类型层面要分开说**：`MediaSegment::key` 是 `Option<Key>`，且 `parser.rs` 在**每段之后**
  都把 `encryption_key` 重置为 `None`（`SegmentTag::Uri` 分支末尾），即**该 crate 自身不做粘性解析** ——
  一个 KEY 标签只作用于紧随其后的那一段。所以 `None` 的**字面**含义是「这一段前面没有 KEY 标签」；
- 但 **HLS 规范要求粘性**（KEY 标签持续生效至下一个 KEY 标签），因此**所有合规消费者**都必须自己维护
  `current_key`，且只在 `seg.key` 为 `Some` 时更新。对消费者而言，`None` 就等价于「沿用上一段的密钥」；
- 于是 **「解析失败」被翻译成了「沿用上一段的密钥」** —— 一个错误的标签被无声地"成功"解释了。

这正是本 issue 的伤害路径（明文段沿用上一段的 AES-128 密钥 → Unpad Error）。
**因此任何加在 `from_hashmap` 里的语义校验，都等于给"静默降级"多加一个触发点。**

由此得到一条设计原则（它是 §4.2b 备选方案的形状依据；本 PR 只删掉了那条与它冲突的写反校验，
未做更广的属性取值放宽）：

> `#EXT-X-KEY:` 前缀一旦匹配，除 `METHOD` 缺失（真正无法构造 Key）外，**必须**产出
> `SegmentTag::Key`。属性级异常一律降级为"该字段为 `None`"，绝不允许降级为"该标签不存在"。

据此，`METHOD=AES-128` 缺 `URI`（用例 05）**应当放行**：解析器产出 `uri = None`，
由消费方在有上下文的层给出可操作错误（FluxDown 引擎即会报 `AES-128 KEY tag missing URI`）。
把这条校验塞进解析器，只会把它变成又一次静默降级。

### 4.4 一个需要一并处理的 writer 侧不对称（可选，未纳入补丁）

`Key::write_attributes_to` 无条件写 `METHOD={}`，再按 `Option` 追加其余属性：

```rust
write!(w, "METHOD={}", self.method)?;
write_some_attribute_quoted!(w, ",URI", &self.uri)?;
write_some_attribute!(w, ",IV", &self.iv)?;
...
```

于是 `Key { method: None, uri: Some(..) }` 会写出 `METHOD=NONE,URI="k"`，
违反 RFC 8216 §4.3.2.4「METHOD 为 NONE 时其他属性 MUST NOT 出现」。

上游原版不会暴露这点（那种输入在解析期就被降级了），但**修好解析后就会暴露**
（用例 03 现在能解析出 `uri = Some(..)`，回写即成非法形态）。若要连带处理：

```rust
write!(w, "METHOD={}", self.method)?;
if self.method != KeyMethod::None {
    write_some_attribute_quoted!(w, ",URI", &self.uri)?;
    write_some_attribute!(w, ",IV", &self.iv)?;
    write_some_attribute_quoted!(w, ",KEYFORMAT", &self.keyformat)?;
    write_some_attribute_quoted!(w, ",KEYFORMATVERSIONS", &self.keyformatversions)?;
}
Ok(())
```

取舍：这会让 `METHOD=NONE,IV=0x…`（用例 02）这类非法输入在 round-trip 后被**规范化**成
`METHOD=NONE`（丢掉多余属性）—— 行为变化，但方向是向规范收敛。
本补丁**未**包含此项，以免把修复范围扩大到改写路径；建议作为独立议题。

### 4.5 各方应对

| 方案 | 位置 | 说明 |
|---|---|---|
| **根治（已提交，待上游）** | `m3u8-rs` | **PR #95** 按 §4.2 的最小修改提交（+36 / −3，含 2 个回归测试）。**不要**采纳 #76 现有的翻转写法。 |
| **兜底（✅ 已实现，PR [#715](https://github.com/zerx-lab/FluxDown/pull/715) 已提）** | FluxDown `hls_downloader.rs` | 识别 `seg.unknown_tags` 里 `tag == "X-KEY"` 且属性含 `METHOD=NONE` 的项，显式把 `current_key` 重置为「无加密」。**已实现（+100 / −1，含 2 个测试，实时流实测通过）**，详见 §6；**与上游修复的兼容性已用三配置差分证明**，详见 §6.2。 |
| **不要做** | 本插件 | 把 `#EXT-X-KEY:METHOD=NONE` 改写为 `METHOD=NONE,IV=0x00…0` 以穿过那条写反的守卫。双重代价：违反 RFC 8216；插件不能返回 playlist 内容，只能借本地 adfilter 服务改写。 |

**上游修复的现实预期**：该仓库有 **12 个 open PR + 9 个 open issue**（含本仓库的 #95；`open_issues_count` = 21 是两者之和，
别误读成 20 个 issue），维护者最后一次提交是 2026-07-30，**PR #76 挂了近两年零回应** →
同类 PR 的合入时间**不可预期**。
**不要把可用性押在上游发版上** —— 应优先做上表的引擎兜底（§4.5 第 2 行）。

**若上游改口/要求调整**：PR #95 的工作副本在 `.workbuddy/tmp/_diag/_fork/m3u8-rs/`，
已配 `upstream` remote；改动后 `git push` 即自动更新 PR。

### 4.6 两条路线的取舍（实测数据，PR 形状的决策依据）

| | **最小修改（采用）** | 纯提取（未采用） |
|---|---|---|
| 改动量 | `−3 / +0` 修复 + 2 个回归测试 = **+36 / −3** | `−22 / +72`（3 hunk，含 3 个测试） |
| 修好 | 01 / 03 / 11 | 01 / 03 / 06 / 11 / 13 |
| 仍降级 | 06 / 07 / 10 / 12 / 13 | 07 / 10 / **12** |
| 原则自洽 | 是（解析保持严格，只删掉写错的那条校验） | **否**（见 §4.1 结论 3） |
| 回归风险 | 零（不改变任何其他输入的行为） | 低，但放宽了若干 RFC 非法输入的接受度 |
| 过审摩擦 | 最小 | 需额外解释"为何要放宽引号" |
| 行为主张 | 每条都有用例支撑 | 含零现场证据的宽容承诺 |
| 测试 | 23 单元（21 + 2）+ 24 集成 通过 | 24 单元（21 + 3）+ 24 集成 通过 |

**现场证据只支持"最小修改"**：真实世界观测到的失败形态只有一种 —— RFC 完美、无 IV 的
`METHOD=NONE`。`IV="…"` / `URI=k` / `METHOD="…"` 这类引号违规**没有任何现场证据**，
把它们一并纳入修复，等于用 diff 规模换取无法验证的健壮性。

**决策（2026-09-30）**：PR #95 采用**最小修改**。三条定稿原则：
① 保证健壮的前提下取最小改动；② 一个 PR 只解决一个问题；
③「`EXT-X-KEY:` 永不降级」另开议题，本 PR 不动。

**独立议题：让 `EXT-X-KEY:` 永不降级。** 它本质上是 `from_hashmap` 的 `Err` 被翻译成
「沿用上一段密钥」这一**设计缺陷**，彻底解法在 `parser.rs` / `MediaSegment::key` 的类型层面
（让"有 KEY 标签但解析失败"可表达），而非靠放宽属性取值来打补丁。与之同源的还有：
`METHOD` 取值不宽容（用例 12）、writer 侧 `METHOD=NONE` 仍写出其余属性（§4.4）、
属性名小写化（用例 07）；「纯提取」方案（§4.2b，含 `unquoted_string!` 宏清理）
可作为该议题的起点。

### 4.7 改动影响面（穷举差分实测）—— "会不会引入新 bug"

方法：`m3u8test/src/bin/diff_matrix.rs` 枚举 `#EXT-X-KEY:` 的属性组合 ——
`METHOD` 7 种（缺失 / `AES-128` / `NONE` / `SAMPLE-AES` / `SAMPLE-AES-CTR` / `大写带引号` / 小写）
× `IV` 3 种（缺失 / 裸值 / 带引号）× `URI` 3 种 × `KEYFORMAT` 3 种 = **189 个组合**。
同一份工程分别链接「原版 6.0.1」与「只删守卫」，打印 `seg.key` 表达力 + `unknown_tags`
+ **re-serialize 后的文本**，逐字符比对。

结果：**只有 4 个组合行为变化（4/189 ≈ 2.1%）**，全部满足 `METHOD=NONE` 且 `IV` 缺席：

| 输入 | 原版 | 修复后 |
|---|---|---|
| `#EXT-X-KEY:METHOD=NONE` | `key=None` · `unknown=[X-KEY(METHOD=NONE)]` | `key=Some(Key{method:NONE})` · `unknown=[]` |
| `…METHOD=NONE,KEYFORMAT="identity"` | 同上 | `key=Some(Key{method:NONE,kf:"identity"})` |
| `…METHOD=NONE,URI="k"` | 同上 | `key=Some(Key{method:NONE,uri:"k"})` |
| `…METHOD=NONE,URI="k",KEYFORMAT="identity"` | 同上 | `key=Some(Key{…,kf:"identity"})` |

（`IV`/`URI`/`KEYFORMAT` 写成**不带引号**的那些组合，在走到这条守卫**之前**就已被
`quoted_string!` / `unquoted_string!` 的 `Err` 拦下 → 两版行为相同。该守卫的实际可达条件比看起来更窄。）

**三条边界结论**：

1. **改动是单调的**：删掉的 3 行只可能把 `Err` 变成 `Ok`，**不可能把 `Ok` 变成 `Err`**
   → 无法让任何原本能解析的标签变得不能解析，因此不可能引入新的解析失败。
2. **写回文本逐字符不变**：上表 4 个组合的 re-serialize 结果两版**完全相同**
   （降级为 unknown tag 时按原样回写；解析成 `Key` 后 writer 产出的文本也一致）
   → 任何依赖 "parse → write" 的消费者，其输出不受影响。
3. **其余 185 个组合逐字符相同** —— 含 `SAMPLE-AES` / `SAMPLE-AES-CTR` / Widevine DRM /
   缺 METHOD / 小写属性名 / `METHOD="…"`，即引擎既有的拒绝路径与告警路径全部不变。

**唯一的"新"风险不在本 crate，而在消费者侧**：修复后 `METHOD=NONE` **第一次能到达**消费者的
`match key.method`。若某消费者的 `None` 分支缺失（或写成 `other => Err(...)`），它会从
"以前侥幸按明文下完"变成"报错"。FluxDown 引擎已有正确的分支
（`hls_downloader.rs`：`KeyMethod::None => Some(HlsKey { method: None, uri: "", iv: None })`，
且下游只在 `method == Aes128` 时才解密）—— 该分支此前是**不可达代码**，本次修复使其首次生效，
且行为正确。这是**激活既有正确逻辑**，不是引入新逻辑。

## 5. 修复后如何验证

用 `m3u8-rs` 重新解析 dai 流，**实测**对照（同一工程，仅切换 `m3u8-rs` 依赖路径）：

```
上游 6.0.1 : seg[ 4] key=noKeyTag(沿用上一段密钥)  unknown=[X-KEY(METHOD=NONE)]
应用补丁后 : seg[ 4] key=Some(Key[NONE iv=-])      unknown=[]
```

即 `METHOD=NONE` 被正确识别、不再落入 `unknown_tags`；随后 FluxDown 的 `KeyMethod::None` 分支生效，
明文段不再解密，下载可完成。

> 注意：`seg[5]` 起仍是 `key=None` —— 这是**正确**的，m3u8-rs 不做粘性密钥解析，`None` 只表示
> 「该段前面没有 KEY 标签」。判定修复是否生效，**只看 `METHOD=NONE` 那条标签所在的那一段**。

**回归基线 = §4.1 的 13 个用例。** 补丁自带 2 个测试：

| 测试 | 作用 | 未修复基线上 |
|---|---|---|
| `key_none_after_aes128_is_not_inherited` | 复刻真实故障形态（AES-128 段后跟 `METHOD=NONE`），断言第二段 `key = Some(method: None)` 且 `unknown_tags` 为空 | **FAILED**（实测证伪） |
| `key_aes128_without_iv_is_parsed` | 守住院 04：`METHOD=AES-128` 无 IV 必须仍能解析 —— 防的是 #76 式翻转写法 | pass（守护测试） |

在 fork 上实测 `cargo test`：**23 passed**（21 原有 + 2 新增）+ 24 集成全通过；
`cargo fmt --check` 干净；编译告警仅 `src/parser.rs` 原有的 2 条
`field 0 is never read`（补丁未触碰该文件）。

> ⚠️ **`cargo test --doc` 在本机 Windows 上会全数失败**，报
> `Failed to spawn rustc: Os { code: 231, "所有的管道范例都在使用中" }`。
> 那是**管道/handle 耗尽的环境问题，与代码无关** —— 已实测在**未打补丁的纯净基线**上同样 6 failed。
> 以 CI（Linux）的 doctest 结果为准。

⚠️ **只看"`METHOD=NONE` 能解析了"就合入，等于重蹈 #76 的覆辙。**
必须同时确认 04 / 08 / 09 没有退化 —— 这正是 §4.1 表格存在的意义。

---

## 6. 引擎侧兜底（✅ 已实现，FluxDown 仓库）

上游修复不可预期，故在**消费者侧**同步做了兜底。本插件不受影响，但 FluxDown 用户的下载体感由它决定。

**位置**：`native/engine/src/hls_downloader.rs::parse_m3u8_bytes` —— 引擎里**唯一**解析 playlist 的文件，
`current_key` 也只此一处维护（已 `grep` 全 `native/` 确认）。改动 1 file / **+100 / −1**，含 2 个测试。

**核心**：引擎自己维护粘性密钥（其注释已说明 m3u8-rs 的 `key` / `map` 字段逐段重置、不做跨段传播），
而 `seg.key == None` 在它的状态机里表示「沿用上一段密钥」。上游把 `METHOD=NONE` 标签丢掉后，
「本段没有 KEY 标签」与「标签被丢弃」不再可区分 —— 兜底就是把后者识别回来：

```rust
if seg.key.is_none() && has_dropped_ext_x_key_method_none(seg) {
    current_key = Some(HlsKey { method: HlsKeyMethod::None, uri: String::new(), iv: None });
}
```

识别函数只按 RFC 8216 §4.2 的严格拼写比对属性项（`METHOD=NONE`，`=` 两侧无空白），
**不为任何非法拼写放宽** —— 与上游 PR（§4.2）遵循同一原则：无现场证据的行为扩张不做。
另已核实 `ext_tag` 用 `is_not("\r\n")` 取 `rest`，故 **CRLF 输入下也不会带尾随 `\r`**。

**受影响的另外两条路径（已逐一核对，均无副作用）**：

| 位置 | 现状 | 结论 |
|---|---|---|
| `uses_computed_iv`（续传资格判定） | 遍历段找「`Aes128` 且无 IV」 | 明文段不再被计入 → **少一个误报**，方向是放宽续传，正确 |
| `key_info`（解密入口） | 仅 `method == Aes128 && !uri.is_empty()` 才解密 | 明文段 `key = None` → 直接跳过解密，正确 |

**实测验证**（本机 Windows / rustc 1.98.1）：

| 项 | 结果 |
|---|---|
| 真实流 `test-streams.mux.dev/dai-discontinuity-deltatre` 走**引擎**解析 | `seg[0..3]` = AES-128（key URI 已解析为绝对地址）、**`seg[4..7] key = None`**；修复前 `seg[4]` 会沿用 `key4` 并触发 Unpad Error |
| 证伪检验 | `test_parse_m3u8_bytes_ext_x_key_method_none_ends_encryption` 在**未修复基线**上 FAILED（`METHOD=NONE must end encryption instead of inheriting the previous key`） |
| 守门测试 | `test_parse_m3u8_bytes_unrelated_unknown_tag_keeps_sticky_key` 通过（其他未知标签不得改动密钥状态） |
| `cargo test -p fluxdown_engine --lib` | **994 passed / 1 failed / 1 ignored**，新增 2 项通过 |
| `cargo fmt --check` / `cargo clippy -p fluxdown_engine --all-targets -- -D warnings` | 通过 |

> ⚠️ 那 1 项 failed 是 `db::tests::exclusive_open_rejects_second_writer_until_guard_drops`
> （`fs2::try_lock_exclusive` 的同进程语义与断言预期不符），**在未含本改动的基线上同样失败**
> —— 已用 `git stash` 对照证伪，与本改动无关。

**上游提交状态**：改动已提交在 fork `cocolight/FluxDown` 分支 `fix/hls-ext-x-key-method-none`（`dd0cc64`），
**分支已推送**（2026-09-30，经 HTTPS + `gh` 凭据助手 —— 本机 SSH 被 `~/.ssh` 权限规则拦），
**PR 已创建：[zerx-lab/FluxDown#715](https://github.com/zerx-lab/FluxDown/pull/715)**
（`OPEN` / `MERGEABLE` / `mergeStateStatus=CLEAN`，1 file，+100 −1，未 draft）。
PR **目标分支是 `main`**（`CONTRIBUTING.md` 明确：`stable` 只由维护者从 `main` 合并前进）。
远端核实：`compare/main...cocolight:fix/hls-ext-x-key-method-none` = `ahead_by 1 / behind_by 0`。
补丁 `docs/engine-hls-ext-x-key-method-none.patch`（131 行，与提交逐字节一致）。

> **该 PR 不会出现任何 CI checks，属预期**：仓库里唯一响应 `pull_request` 的是 `website-ci.yml`，
> 而它带 **路径过滤**（仅 `website/src/content/**`、`website/src/pages/docs/**` 等）。
> 本 PR 只动 `native/engine/src/hls_downloader.rs` → 工作流不触发 → GitHub 显示
> 「no checks reported」。**这不是失败，也不代表验证缺失** —— 本地验证是唯一证据（见上表）。

### 6.2 ★ 与上游修复的兼容性：三配置差分实测

**问题**：若上游 #95 合入并升级依赖，这段兜底会不会重复生效、冲突，或必须再提一个 PR 改代码？

**方法**：把 #95 的补丁打到 `m3u8-rs 6.0.0` 源码副本（`patch -p1` 干净应用），用 `[patch.crates-io]`
临时让引擎依赖**已修复**的 crate，跑同一个探针打印引擎**归一化后**的每段密钥状态。三种配置：

| # | m3u8-rs | 引擎兜底 | 探针输出 |
|---|---|---|---|
| **A** | 6.0.0（含 bug） | 有 | `seg[0] key=Some(Aes128, uri=https://cdn.example.com/live/key.bin, iv=None)`<br>`seg[1] key=None` / `uses_computed_iv=true` / `n_segments=2` |
| **B** | 已打 #95 | 有 | **与 A 逐字符相同** |
| **C** | 已打 #95 | **删掉** | **与 A 逐字符相同**；37 项测试全绿（含 2 个新测试）；仅剩 `function is never used` 警告 |

**结论（可证伪地成立）**：

1. **完全兼容、无双重处理**。上游修复后 `seg.key = Some(Key{method: None, …})`，走既有的
   `&m3u8_rs::KeyMethod::None` 分支置 `current_key`；此时兜底的入口条件 `seg.key.is_none()` 为 **false**，
   **短路跳过** → 兜底成为**永不执行的死分支**，不会重复生效。
2. **等价性**：两条路径最终都让 `current_key` 变成 `HlsKeyMethod::None`，而引擎对外暴露的
   `HlsSegment.key` 只在 `Aes128` 时才为 `Some`（`parse_m3u8_bytes` 里的 `seg_key` 归一化）
   → **三配置的归一化输出逐字符相同**。另外两条消费路径（`uses_computed_iv`、`key_info`）
   读的都是这个**归一化后**的 `segment.key`，因此同样无差异。
3. **两个新测试是上游无关的**：它们断言的是引擎归一化后的 `HlsSegment.key`（`HlsKeyMethod`），
   **不是** m3u8-rs 的原始字段 —— 所以上游修复后**不会失败**（配置 C 实测通过）。
4. **需要再提 PR 吗**：**功能性上不需要** —— 上游修复后不改 FluxDown 也能正常工作。
   **整洁性上建议再提一个小 PR**（等 FluxDown 把 `m3u8-rs` 升到含修复的版本时）：
   删掉这段兜底 + 那个识别函数，消除死代码。届时**务必先跑本节的配置 C 验证**（删掉后 2 个测试仍应通过），
   再提交，避免把尚在使用的逻辑删掉。该 PR 与上游 PR **无关、可独立进行**。

> 实测提醒：临时改 `Cargo.toml` 接本地 crate 会让 `Cargo.lock` 一起变化 —— 收尾用
> `git checkout -- native/engine/src/hls_downloader.rs Cargo.toml Cargo.lock` 一次性还原，
> 再用 `git status --porcelain` 确认工作区回到提交状态（本次实测 36 项测试复跑全绿）。

### 6.1 该仓库的贡献约束（提 PR 前必读，已踩过）

| 约束 | 内容 | 影响 |
|---|---|---|
| **注释禁止引用 issue/PR 编号** | `.omp/rules/no-meta-in-comments.md`：注释只写**当前行为/不变式/取舍**，背景放 commit message；RFC 编号允许 | 初稿注释里写的"上游修复见…#95"**违规**，已改写 |
| **无 PR 级 Rust CI** | 只有 `website-ci.yml` 响应 `pull_request`；`cargo test --locked -p fluxdown_engine` + `cargo fmt --check` 在 `release.yml`，仅 `workflow_dispatch` | **PR 上不会出现 checks**，本地验证是唯一证据 |
| **Conventional Commits + 中文 subject** | `.opencommit-commitlint`、`cliff.toml`；实测 scope 用 `fix(engine):` | 提交信息格式 |
| **clippy deny** | `unwrap_used` / `expect_used` / `wildcard_imports`；`#[cfg(test)]` 内除外 | 新代码与测试都不用 `unwrap` / `expect` |
| **禁止新增 dependency、禁手编版本号** | `AGENTS.md` §7、`.omp/rules/dependency-policy.md` | 本改动无依赖变更 |
| 提交前门槛 | `cargo fmt --check && cargo clippy -- -D warnings` | 已过 |

**连带发现的既有问题（不在本 PR 范围，未修）**：Windows 上
`db::tests::exclusive_open_rejects_second_writer_until_guard_drops` 稳定失败（同进程第二次
`Db::open_exclusive` 未返回 `WriterLeaseHeld`）。已用基线对照证实与本改动无关，遵循「一个 PR 只解决一个问题」未纳入。
