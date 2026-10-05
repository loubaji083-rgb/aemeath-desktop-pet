# voice-training/manifests

调用 `make-manifest.mjs` 后，生成的清单默认写在这里：`dataset.manifest.json`。

```
node voice-training/scripts/make-manifest.mjs                       # 扫描 ../data/ 生成/更新
node voice-training/scripts/validate-dataset.mjs                    # 校验（默认读 dataset.manifest.json）
```

## `example.manifest.json` 是**故意不合格**的

它由工具真实生成、原样保留，用来示范两件事：

1. **结构长什么样**（`schemaVersion` / `name` / `language` / `license` / `consent` / `speakers` / `clips` / `notes`）。
2. **红线字段必须由你本人改写**。它的 `license` 还是工具给的占位串，所以校验会明确失败：

```
$ node voice-training/scripts/validate-dataset.mjs --manifest voice-training/manifests/example.manifest.json
—— 错误 ——
  [license-missing] license: 缺少有效的素材授权说明 ……（不接受占位值）
  [speakers-empty] speakers: speakers 不能为空，至少需要一个说话人
—— 警告 ——
  [clips-empty] clips: clips 为空：结构合法，但还没有可训练的数据
结果：失败（2 个错误）；警告 1 条     # 退出码 1
```

**这个失败是设计的一部分，不是 bug。** 工具链只给流程，不给任何声优声线、预训练权重或音频素材；
`license` / `consent` 里的授权说明与告知同意，必须由你自己如实填写并自负权利与法律后果。
占位值（`待填` / `TBD` / `示例` / `来源：待填` 这类）一律会被 `validate-dataset.mjs`
与插件「训练」面板拒绝 —— 这条判定在 Node 脚本和浏览器两份实现里是同步的。

字段级规范见 [`../SCHEMA.md`](../SCHEMA.md)，训练路线见 [`../scripts/README.md`](../scripts/README.md)。
