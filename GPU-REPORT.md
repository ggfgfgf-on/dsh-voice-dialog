# GPU-REPORT：人声分离 DirectML 实测

## 结论

- **onnxruntime-node 1.31.1 的 Windows x64 预编译包支持 DirectML**。无需更换为 onnxruntime-directml 包。
- **本次同条件 4 秒窗实测中位数：CPU 3850.0 ms，DML 374.0 ms，DML 冷启动 2088.0 ms。**
- DML 比 CPU 快约 **10.3 倍**，但**没有达到 <300 ms 的目标**；中位数超出 74 ms（24.7%），如实记录，不宣称达标。
- GPU 不可用时的 CPU 回落已实测：请求 `dml`、指定无效 adapter 时，实际 `backend=cpu`，分离仍返回正常结果。

> 现状核对：仓库 HEAD 和当前安装副本的 worker 原本都已有硬编码的 `['dml','cpu']` 尝试；本次不是“首次启用 DML”，而是把 provider 选择固定下来、可配置、可观测，并验证真实 GPU 性能与 CPU 回落。下面的“改前”按 CPU EP 对照给出。

## 1. EP 支持性证据

运行时版本和 EP 列表：

```powershell
cd D:\DSHwork\dsh-voice-dialog
node -e "const ort=require('onnxruntime-node');console.log('version='+require('onnxruntime-node/package.json').version);console.log(JSON.stringify(ort.listSupportedBackends()))"
```

输出：

```text
version=1.31.1
[{"name":"cpu","bundled":true},{"name":"dml","bundled":true},{"name":"webgpu","bundled":true}]
```

包内 Windows x64 DLL：

```powershell
Get-ChildItem 'D:\DSHwork\dsh-voice-dialog\node_modules\onnxruntime-node\bin\napi-v6\win32\x64' -Filter *.dll | Select-Object -ExpandProperty Name
```

```text
DirectML.dll
dxcompiler.dll
onnxruntime.dll
```

结论：有 **DirectML.dll**，没有独立的 **onnxruntime_providers_directml.dll**；该版本的 DML EP 编入主 `onnxruntime.dll`，`listSupportedBackends()` 明确报告 `dml bundled=true`，实际 session 也报告 `backend=dml`。因此当前运行时确实可用 DML，不是“假装成功”。

本机显示适配器：AMD Radeon(TM) Graphics、NVIDIA GeForce RTX 5070 Laptop GPU。实测固定使用 DirectML `deviceId=0`。

## 2. 实测数字

测试条件：

- 模型：`C:\Users\chesand\.dsh\voice-dialog\models\mossformer2_ss_16k.onnx`，245,120,037 bytes
- 音频：`test/.latency/speech3.wav`（真实录音，16 kHz mono PCM16，11.2 s）
- 窗：64000 samples = 4.000 s；三个起点的真实音频窗：0.0 s、3.6 s、7.2 s
- 每个 EP：先跑一次 warm-up 不计时，再跑 3 次取中位数；冷启动另起 3 个 worker，各测 3 次取中位数
- 指标：`inferenceMs` 为 worker 内 `separateWithRunner` 的推理耗时（不含 fork IPC）；另列端到端 wall 供核对
- 测试时间：2026-10-28（见 `test/.latency/gpu-results.json` 的 `measuredAt`）

| 项目 | 3 次样本 (ms) | 中位数 (ms) |
|---|---:|---:|
| **CPU 推理** | 3852, 3824, 3850 | **3850.0** |
| **DML 推理** | 362, 384, 374 | **374.0** |
| DML wall（含 IPC） | 363.4, 384.7, 374.9 | 374.9 |
| CPU wall（含 IPC） | 3853.2, 3825.1, 3851.5 | 3851.5 |
| **DML 冷启动** | 2094, 2084.6, 2088 | **2088.0** |
| CPU 冷启动（对照） | 869.7, 798.5, 787.1 | 798.5 |
| 回落验证（无效 DML 设备 → CPU） | — | backend=cpu，推理 3293 ms，输出正常 |

冷启动口径：从创建 `SeparationService` 到 worker 完成 fork、onnxruntime-node 加载和 245 MB 模型 session 创建并 resolve `warm()`。

目标核对：**300 ms 目标未达成**。DML 中位数 374.0 ms > 300 ms。HTTP 层 803 ms 和给定历史冷启动 1998 ms 未重测。

## 3. 实现与配置

默认行为：

- 默认请求链：`['dml']`。
- worker 自动在末尾补 `cpu`，所以实际尝试链为 `dml → cpu`。
- DML 默认 `deviceId=0`；可用 `DSH_SEPARATION_DML_DEVICE_ID` 覆盖。
- DML 创建失败、设备不可用，或 DML session 已创建但运行时推理失败，都会释放 session 并改走 CPU；不会把 GPU 故障传成“识别失败”。

可配置方式：

```powershell
# 默认已等价于 dml；显式指定其它链时会自动追加 cpu
$env:DSH_SEPARATION_EXECUTION_PROVIDERS = 'dml'
$env:DSH_SEPARATION_DML_DEVICE_ID = '0'

# 强制 CPU 验证
$env:DSH_SEPARATION_EXECUTION_PROVIDERS = 'cpu'
```

构造函数也支持：

```ts
new SeparationService({
  executionProviders: ['dml'],
  dmlDeviceId: 0,
})
```

日志可明确看出后端：

```text
[dsh-voice-dialog] separation provider=dml requested=dml
[dsh-voice-dialog] separation provider=cpu requested=dml (CPU fallback)
```

## 4. 测试与构建

```powershell
cd D:\DSHwork\dsh-voice-dialog
node build.mjs
node --test test/*.test.mjs
```

结果：

- `node build.mjs`：成功。
- `node --test test/*.test.mjs`：**85 pass，0 fail**。
- 说明：当前工作树中另有并行存在的 organizer 相关测试文件，导致实际汇总数高于任务给定的 74；本次没有向 `*.test.mjs` 增加测试，GPU benchmark 文件名为 `gpu-benchmark.mjs`，不会被该命令收集。

## 5. 改动文件

本次改动/新增：

- `src/separation.ts`：provider 配置、DML deviceId、状态字段、后端日志、worker 初始化参数。
- `src/separation-worker.ts`：provider 尝试链、dml provider option、启动/运行时 CPU 回落、backend 上报。
- `lib/separation.js`、`lib/separation-worker.js`：构建产物。
- `test/gpu-benchmark.mjs`：真实模型/音频、3 次 CPU/DML/冷启动基准与回落验证。
- `test/.latency/gpu-results.json`：本次完整结果。
- `GPU-REPORT.md`：本报告。

未改音量、声纹、组织器（organizer）相关代码；未提交 git；未重启 DSH。

## 6. 回滚

源码回滚到本次改动前：

```powershell
cd D:\DSHwork\dsh-voice-dialog
git checkout -- src/separation.ts src/separation-worker.ts
Remove-Item test/gpu-benchmark.mjs,GPU-REPORT.md -ErrorAction SilentlyContinue
node build.mjs
```

注意：HEAD 源码本来就包含硬编码的 DML→CPU 尝试；执行上面的 checkout 后，会回到“会尝试 DML 但不可配置、无设备选择、无明确 backend 日志”的旧状态，而不是纯 CPU 状态。

本次已在最后一步把 `lib/separation.js`、`lib/separation-worker.js` 复制到安装副本 `D:\deepseek-harness-dsh-v0.2.1rc2\.dsh-home\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib\`，未重启 DSH。复制前的两个原文件已备份到 `test/.latency/profile-before-separation.js` 和 `test/.latency/profile-before-separation-worker.js`。若要回滚安装副本：

```powershell
Copy-Item test/.latency/profile-before-separation.js "D:\deepseek-harness-dsh-v0.2.1rc2\.dsh-home\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib\separation.js" -Force
Copy-Item test/.latency/profile-before-separation-worker.js "D:\deepseek-harness-dsh-v0.2.1rc2\.dsh-home\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib\separation-worker.js" -Force
```

这两个安装文件不在 git 仓库内，不能靠 git checkout 恢复。
