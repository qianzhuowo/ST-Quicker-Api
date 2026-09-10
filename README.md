# Quicker Api

Quicker Api 是 SillyTavern 原生“API 连接配置”的轻量增强面板，用来更方便地管理 API 配置，同时通过同一份代码适配 TauriTavern。

适合需要在多个 API 地址、密钥和模型之间频繁切换的用户。

受 [SillyTavern-ApiHub](https://github.com/waylon256yhw/SillyTavern-ApiHub) 项目理念的启发，Quicker Api 复用了 SillyTavern 原生功能以实现最大兼容。

## 使用前提

Quicker Api 界面直接显示在 SillyTavern 原生的 **API 连接配置** 中，使用前需要先将 SillyTavern 的 **聊天补全来源** 切换至 **自定义（兼容 OpenAI）** / **Claude** / **Google AI Studio**。

## TauriTavern 兼容

- Anthropic/Gemini 仍只由插件管理“排除主体参数”。TauriTavern 原生已有的该来源附加 Body/Headers 会保留，不被插件顺带清空，也不随 Quicker Profile 切换。
- 暂不新增 TauriTavern 的 OpenAI Responses、Claude Messages、Gemini Interactions 等 Custom 子协议 Profile。它们不会被当作普通 OpenAI Compatible 配置导入。

**升级提醒：** 旧版插件在 TauriTavern 中可能已经漏存附加参数。升级不能凭空恢复未保存的内容；更新前建议备份原生附加参数，更新后重新填写并保存受影响的 Profile。既有 Profile 的数据结构无需转换。

## 功能预览

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/894298f4-c0b7-4ed3-beaf-161a2cfcec22" alt="Quicker Api 配置管理界面" width="100%" />
      <br />
      <sub>API 配置管理</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="https://github.com/user-attachments/assets/74c36eab-06ca-48fa-a7ec-24b351b3ea63" alt="Quicker Api 模型列表管理界面" width="100%" />
      <br />
      <sub>模型列表管理</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="https://github.com/user-attachments/assets/25c97261-78d3-4d1f-a8a0-8039228fff98" alt="Quicker Api 便捷方案菜单" width="303" />
  <br />
  <sub>发送栏便捷方案菜单</sub>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/f82e5f9a-a5be-4066-a752-dbcaa06091c7" alt="Quicker Api 便捷按钮管理界面" width="100%" />
  <br />
  <sub>便捷按钮管理</sub>
</p>

## 主要功能

- **多配置管理** — 保存多个 API 配置，快速新增、切换、重命名、复制和删除
- **支持三种格式** — OpenAI Compatible、Anthropic、Gemini
- **统一保存** — 一次保存 API 格式、URL、Key、模型和配置名称；三种格式均可按 Profile 保存排除主体参数
- **快捷 URL** — 一键填入 SillyTavern 常用服务端点，也可添加和删除自己的 URL 简称
- **原生密钥管理** — 密钥继续保存在 SillyTavern 的原生 Secrets 中，不写进插件配置
- **模型列表管理** — 从 API 获取模型，也可以手动添加、编辑、排序和筛选模型
- **迁移原生配置** — 批量导入 SillyTavern 当前的 OpenAI 配置
- **预设联动** — 可以让不同的对话补全预设自动使用对应的 API 配置和模型
- **面板折叠** — 收起后只显示“格式 · 配置名 · 模型名称”，展开/收起状态仅由当前浏览器记忆
- **便捷方案** — 一键组合切换“对话补全预设 + API 配置 + 模型”
- **保存附加参数** — 配置与附加参数一起保存

> 简单来说，目前支持以下功能：
- 在自定义兼容格式下实现方便地切换api配置
- 自定义调整模型的下拉列表展示项！（再也不用在一堆模型里翻自己需要的那几个模型了 ）
- 自定义切换方案，实现 api、预设、模型的便捷切换！三者可以自由搭配，单切模型、只切预设和模型之类的方案都可以
- 附加参数可以跟随配置一起切换

## 支持的 API 格式

| API Format | 对应 SillyTavern 来源 | 说明 |
|---|---|---|
| OpenAI Compatible | Custom（兼容 OpenAI） | 支持自定义 URL、Key、模型和附加参数，并保留原生 Custom 推理内容解析 |
| Anthropic | Claude | 可使用官方 API或 其它支持 Claude 格式的端点，并支持按 Profile 排除请求顶层参数 |
| Gemini | Google AI Studio | 可使用官方 API或 其它支持 Gemini 格式的端点，并支持按 Profile 排除请求顶层参数 |

## 安装

### 自动安装

打开 SillyTavern：

```text
扩展 → 安装扩展
```

输入以下 GitHub 地址：

```text
https://github.com/qianzhuowo/ST-Quicker-Api
```

### 手动安装

将整个 `ST-Quicker-Api` 文件夹放到：

```text
SillyTavern/public/scripts/extensions/third-party/
```

然后刷新 SillyTavern 页面。

## 基本使用

### 1. 新建 API 配置

1. 打开 SillyTavern 的 **API 连接配置**
2. 将聊天补全来源切换为 **自定义（兼容 OpenAI）** 、Claude 或 Google AI Studio
3. 点击 Quicker Api 中的 **新增配置** 按钮
4. 选择 API Format
5. 填写 URL、Key 和模型；URL 也可通过右侧的 **快捷 URL** 按钮填入
6. 点击 Quicker Api 面板中的“附加参数”：OpenAI Compatible 可编辑原生全部三栏；Anthropic/Gemini 只显示并支持“排除主体参数”
7. 点击 **保存 API 配置**

保存后，这个配置会出现在“当前配置”下拉列表中。OpenAI Compatible 会保存全部三项原生附加参数；Anthropic/Gemini 会保存“排除主体参数”。

### 2. 使用快捷 URL

1. 点击 URL 输入框右侧的 **快捷 URL**
2. 选择 OpenAI、OpenRouter、DeepSeek 等 SillyTavern 常用服务，URL 会立即填入输入框
3. 点击菜单底部的 **添加快捷 URL**，可保存自己的“简称 + URL”
4. 自定义项目右侧的删除按钮只会删除该快捷项，不会删除任何 API Profile

快捷 URL 只负责填入地址；仍需点击 **保存 API 配置** 才会把新地址写入当前 Profile。

### 3. 切换配置

直接在“当前配置”下拉列表中选择需要的配置。

插件会安全切换对应的：

- API 来源
- URL
- 密钥或代理密码
- 模型
- 当前格式支持的附加/排除参数

切换成功后，状态栏会显示“已保存并安全应用”。

“排除主体参数”沿用 SillyTavern 原生 YAML 语法，例如：

```yaml
- temperature
- top_p
- frequency_penalty
```

发送前，Quicker Api 会确认配置的格式，再删除这些请求顶层字段。在 TauriTavern 中，排除规则通过原生参数存储交给宿主后端，在最终请求主体上应用。

### 4. 管理密钥

Key 输入框支持：

- 点击眼睛显示或隐藏密钥
- 复制当前密钥
- 打开 SillyTavern 原生密钥管理器

切换配置时，插件不会自动把已保存密钥明文填进输入框。只有点击眼睛或复制时，才会按需读取密钥。

## 模型列表

OpenAI Compatible 配置提供：

- **添加** — 手动添加任意模型 ID
- **获取模型** — 从当前 API 的 `/models` 获取模型
- **管理模型列表** — 选择常用模型、添加自定义模型、编辑、删除和调整顺序

每个 API 配置都有自己独立的模型列表。切换配置时，对应的模型列表也会一起切换。

如果浏览器无法直接访问 `/models`，插件会自动尝试通过 SillyTavern 后端获取。

## 导入原生 OAI 设置

点击 **导入原 OAI 设置**，可以扫描 SillyTavern 当前 OpenAI 配置

插件会自动过滤已经导入过的相同配置，选择需要的配置后点击“添加”即可。

导入不会删除或修改原来的 SillyTavern 配置。

## 折叠面板

点击 Quicker Api 标题栏可收起/展开面板，也支持聚焦后按 Enter 或空格。

收起后仅显示：

```text
OpenAI Compatible · 我的配置 · gpt-4.1
```

## 对话补全预设联动

Quicker Api 可以让 SillyTavern 的对话补全预设记住 API 配置。

推荐用法：

1. 选择一个 Quicker API 配置
2. 选择需要的模型
3. 点击 **保存 API 配置**
4. 保存或更新当前 SillyTavern 对话补全预设

以后切换这个预设时，插件会自动恢复绑定的 API 配置和密钥。

同一个 API 配置可以绑定多个预设，每个预设可以保存不同模型。

已绑定的 Quicker Api 预设会恢复其 API 配置及模型，不依赖原生“预设绑定连接”开关；未绑定的预设仍由 SillyTavern 自行处理。

## 便捷方案

“便捷按钮管理”可以创建一键切换方案。每个方案可以自由组合：

- SillyTavern 对话补全预设
- Quicker API 配置
- 模型

例如：

```text
日常聊天 = Claude 预设 + Anthropic 配置 + claude 模型
快速回复 = 简短预设 + OpenAI Compatible 配置 + flash 模型
```

保存后，点击发送栏附近的闪电按钮即可快速切换。

便捷入口可以放在：

- 发送栏左侧
- 发送栏右侧
- Quick Reply 按钮栏
- 不使用便捷按钮

方案会按照以下顺序安全执行：

```text
对话补全预设 → API 配置 → 模型
```

## SillyTavern 需要修改的设置

### 允许读取已保存密钥（可选但推荐）

编辑 SillyTavern 的 `config.yaml`：

```yaml
allowKeysExposure: true
```

修改后重启 SillyTavern。

启用后，Quicker Api 才能：

- 点击眼睛查看已保存密钥
- 复制已保存密钥
- 按密钥内容避免重复保存
- 在迁移原生 OpenAI 配置时复制官方 Key 到 Custom 密钥槽

如果保持为 `false`，插件仍然可以正常保存和切换配置，但不能读取已有密钥明文；部分迁移项目需要手动重新填写 Key。

> 开启 `allowKeysExposure` 后，浏览器端扩展可以请求密钥明文。请只安装可信扩展，不要在不受信任的公网实例上随意开启。


## 数据保存与跨浏览器使用

- API 配置、模型列表、便捷方案、入口位置、快捷 URL 和预设绑定保存在 SillyTavern 的 `extension_settings.quickerApi`。
- **例外：面板展开/收起状态仅保存在当前浏览器的 localStorage，不属于服务端配置。**
- 上述 API 配置等共享数据通过宿主原生设置机制保存，不依赖浏览器本地存储。SillyTavern 使用 `/api/settings/save` 写入当前用户的 `settings.json`（通常位于 `data/<用户>/settings.json`，以数据目录设置为准）；TauriTavern 也可能使用 `/api/settings/patch` 增量保存，实际数据目录由应用管理。
- 密钥保存在 SillyTavern 原生 Secrets 中，Reverse Proxy Password 保存在原生 Reverse Proxy Preset 中。

API 配置保存和便捷方案总保存会等待服务器确认。保存失败或超时会弹出提示，请检查连接后重试保存，不要直接刷新以免丢失未保存的修改。有未确认的设置时，离页会尝试触发浏览器提醒，但移动端强制结束进程不保证提醒生效。

这沿用 SillyTavern 的设置机制，**不是实时推送，也不跨不同服务器/用户自动同步**。不要在多个长期打开的浏览器中同时修改设置：旧页面可能覆盖新页面的更改。切换浏览器编辑前，请先完成保存并在目标浏览器刷新。

插件不会把密钥编辑框的明文写入 Profile、测试日志或 README；不要在自定义 Headers/Body 中填写不希望保存在用户设置里的敏感信息。

卸载插件后，SillyTavern 原生密钥和最后一次应用的连接字段仍然保留。

## 注意事项

- 不要同时启用 Quicker Api 和 API Hub，它们都会管理 API 连接状态
- 检测到 API Hub 时，Quicker Api 会停止接管连接，避免两个扩展互相覆盖
- OpenAI Compatible 支持附加 Body、附加 Headers 和排除参数；Anthropic/Gemini 仅支持排除请求顶层参数
- 如果状态栏显示“安全阻断”，请重新检查或保存对应配置的密钥
- 如果看不到便捷入口，请到“便捷按钮管理 → 位置设置”确认没有选择“不使用便捷按钮”

## 开发与回归验证

业务代码保留在 `index.js`；宿主差异集中在 `platform.js`。新增平台差异时优先扩展适配层，不在 Profile、密钥、预设和便捷方案中散落平台判断。

测试需要 Node.js 22+。浏览器回归还需要 Chromium/Chrome/Edge，以及 SillyTavern 的 `public` 静态资源；插件不在 SillyTavern 目录内时，可设置 `ST_PUBLIC_DIR`，浏览器不在常见位置时可设置 `CHROME_PATH`。

```powershell
# 适配层单元测试（不需要浏览器）
node --test tests/platform.test.mjs

# 双宿主浏览器回归
$env:QUICKER_TEST_HOST = 'sillytavern'
node tests/regression.mjs
$env:QUICKER_TEST_HOST = 'tauritavern'
node tests/regression.mjs

# 可选：直接加载本机 TauriTavern 源码中的参数访问器做契约验证
$env:TT_SOURCE_DIR = 'E:\AiChat\TauriTavern-2.2.0'
node --test tests/platform.test.mjs
```

浏览器测试仅使用内存模拟的设置/密钥接口、虚构 Profile 和临时浏览器目录，不连接真实模型、不读写真实账户配置。测试包含参数 A/B/空配置切换、跨来源隔离、原生编辑/保存、预设联动、便捷方案、启动恢复、导入、失败回滚、全量/增量保存失败与并发修改。

更新到真实应用后，建议再手动检查：

1. 在两个 Profile 中填写不同的 Body、排除规则和 Headers，保存后反复切换，重新打开原生附加参数弹窗核对。
2. 发送到自己控制的测试端点，检查实际收到的请求主体和请求头；自动化测试不替代后端端到端验证。
3. 切换绑定预设及便捷方案，重启应用后确认参数与配置仍一致。
4. 检查 Anthropic/Gemini 的排除规则，以及切换 Profile 不会清空该来源其他原生参数。

## 卸载

删除以下目录：

```text
SillyTavern/public/scripts/extensions/third-party/ST-Quicker-Api
```

然后刷新 SillyTavern 页面。

卸载不会主动删除：

- SillyTavern 原生密钥
- 已保存的插件设置数据
- 最后一次安全应用的原生连接字段
