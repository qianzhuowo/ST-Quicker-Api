# Quicker Api

Quicker Api 是 SillyTavern 原生“API 连接配置”的轻量增强面板，用来更方便地管理 API 配置。

适合需要在多个 API 地址、密钥和模型之间频繁切换的用户。

受 [SillyTavern-ApiHub](https://github.com/waylon256yhw/SillyTavern-ApiHub) 项目理念的启发，Quicker Api 复用了 SillyTavern 原生功能以实现最大兼容。

## 使用前提

Quicker Api 界面直接显示在 SillyTavern 原生的 **API 连接配置** 中，使用前需要先将 SillyTavern 的 **聊天补全来源** 切换至 **自定义（兼容 OpenAI）** / **Claude** / **Google AI Studio**。

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

发送前，Quicker Api 会确认配置的格式，再删除这些请求顶层字段。

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

## 对话补全预设联动

Quicker Api 可以让 SillyTavern 的对话补全预设记住 API 配置。

推荐用法：

1. 选择一个 Quicker API 配置
2. 选择需要的模型
3. 点击 **保存 API 配置**
4. 保存或更新当前 SillyTavern 对话补全预设

以后切换这个预设时，插件会自动恢复绑定的 API 配置和密钥。

同一个 API 配置可以绑定多个预设，每个预设可以保存不同模型。

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


## 数据保存位置

- API 配置和便捷方案保存在 SillyTavern 的 `extension_settings.quickerApi`
- 密钥保存在 SillyTavern 原生 Secrets 中
- Reverse Proxy Password 保存在 SillyTavern 原生 Reverse Proxy Preset 中

插件不会把密钥明文写入 Profile、导出文件或 README。

卸载插件后，SillyTavern 原生密钥和最后一次应用的连接字段仍然保留。

## 注意事项

- 不要同时启用 Quicker Api 和 API Hub，它们都会管理 API 连接状态
- 检测到 API Hub 时，Quicker Api 会停止接管连接，避免两个扩展互相覆盖
- OpenAI Compatible 支持附加 Body、附加 Headers 和排除参数；Anthropic/Gemini 仅支持排除请求顶层参数
- 如果状态栏显示“安全阻断”，请重新检查或保存对应配置的密钥
- 如果看不到便捷入口，请到“便捷按钮管理 → 位置设置”确认没有选择“不使用便捷按钮”

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
