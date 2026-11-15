# LLMs on the Orange Pi 5 Plus NPU, for Stenograma KB

A task for an agent running **on the Orange Pi** (and a few steps the user does on the laptop). Written 2026-11-14.

## Context

Stenograma KB (an Electron app on the user's laptop) uses a local LLM through Ollama's HTTP API for answers, meeting
summaries and reply drafts. The laptop's GPU (Quadro P3200, 6 GB) runs `qwen3.5:9b` only partly, at ~4 tokens/s. The
user's **Orange Pi 5 Plus** (RK3588, 16 or 32 GB RAM, a 6 TOPS NPU) should run LLMs on its NPU, so the background work
moves off the laptop.

The stack:

- **RKLLM** (Rockchip's [rknn-llm](https://github.com/airockchip/rknn-llm), v1.3.x): the NPU runtime for LLMs. Qwen3 /
  Qwen3.5 and Gemma 2 / 3 / 3n / 4 are supported from v1.3.0.
- **[RKLLama](https://github.com/NotPunchnox/rkllama)**: a server with an Ollama-compatible API (`/api/chat`,
  `/api/generate`, `/api/tags`, `/api/ps`, `/api/embed`, part of OpenAI's `/v1/*`) on top of RKLLM. Default port 8080.
- The laptop reaches it through an **SSH tunnel** (`127.0.0.1:11435` on the laptop → `127.0.0.1:8080` on the Pi). The
  app treats only a loopback address as "on this computer" for its privacy rules (F8), so the tunnel lets private
  sources (chats that may not go to cloud AI) use the Pi, and the traffic is encrypted.

What to expect (Rockchip's benchmark on RK3588, w8a8, a 128-token prompt, frequencies fixed at max):

| Model | Decode | Time to first token (128 tokens) | Memory |
|---|---|---|---|
| Qwen3.5 0.8B | 27 tokens/s | 0.6 s | 1.0 GB |
| Qwen3.5 2B | 13.6 tokens/s | 0.8 s | 2.1 GB |
| Qwen3.5 4B | 6.2 tokens/s | 2.1 s | 4.6 GB |
| Gemma4 E2B | 11 tokens/s | 0.6 s | 2.5 GB |

No 7–9B model is in the benchmark (expect ~2–3 tokens/s). The app's summaries and drafts send 3–6k-token prompts, so
the prefill time matters more than the decode speed: **measure it** (step 7).

Embeddings (bge-m3) stay on the laptop for now: bge-m3 is an encoder that RKLLM doesn't run, RKLLama's `/api/embed`
has a known bug (only the first of sequential requests returns a valid vector, issue #117), and a new embedding model
means rebuilding the whole index.

## Constraints (the agent must keep these)

- **Never expose RKLLama to the network.** It has no authentication. Only SSH is open from outside; RKLLama is reached
  through the tunnel. Don't open port 8080 in the firewall, don't publish it with Docker on `0.0.0.0`.
- Don't disable SSH key login or lock the user out: keep the current SSH session open while changing `sshd_config` or
  the firewall, and check a new login works before closing it.
- Download models with `huggingface-cli` (or `rkllama_client pull`), **not `git clone`**: Git LFS pointer files
  (~135 bytes) break the model (`MetadataIncompleteBuffer`) and the tokenizer (`expected value at line 1`).
- Don't upgrade the kernel to a mainline one: RKLLM needs Rockchip's vendor (BSP) kernel with the RKNPU driver.
- Where a flag or a file name below may differ in the installed version, check `--help` or the repository first; don't
  guess.

## Steps on the Orange Pi

### 1. Hardware and OS

- Active cooling (heatsink and fan) is on: without it the NPU throttles. Models go on an NVMe SSD if there is one.
  Wired Ethernet, a static IP or a DHCP reservation.
- The OS is Orange Pi's Ubuntu 22.04/24.04 for the 5 Plus, or Armbian with the **vendor kernel 6.1** (rk35xx).

Check:

```bash
uname -r                                   # 6.1.x, a Rockchip vendor kernel
sudo cat /sys/kernel/debug/rknpu/version   # RKNPU driver 0.9.6 or later
free -h                                    # 16 or 32 GB
```

If the driver is older than 0.9.6 or missing, **stop and report**: the OS image needs updating, which the user decides.

### 2. SSH and the firewall

The user's laptop logs in with a key (`ssh-copy-id` from the laptop, done by the user if not yet). Then:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh            # check a new key login works before closing the current session
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status verbose               # only 22/tcp allowed
```

### 3. Maximum CPU and NPU frequencies

```bash
git clone --depth 1 https://github.com/airockchip/rknn-llm ~/rknn-llm
ls ~/rknn-llm/scripts/                 # find the RK3588 frequency script (fix_freq_rk3588.sh)
sudo bash ~/rknn-llm/scripts/fix_freq_rk3588.sh
```

It doesn't survive a reboot: add a `oneshot` systemd unit (`/etc/systemd/system/npu-freq.service`, `After=multi-user.target`)
that runs the script, and enable it.

### 4. RKLLama

```bash
sudo apt install -y python3-venv git
git clone https://github.com/NotPunchnox/rkllama ~/rkllama
cd ~/rkllama && python3 -m venv .venv && . .venv/bin/activate
pip install .
mkdir -p ~/rkllama-models
rkllama_server --help                  # find how to set the port and the bind address
```

If it can bind to `127.0.0.1` only, do so (the firewall blocks 8080 anyway). Then `/etc/systemd/system/rkllama.service`:

```ini
[Unit]
Description=RKLLama (NPU LLM server)
After=network-online.target

[Service]
User=orangepi
WorkingDirectory=/home/orangepi/rkllama
ExecStart=/home/orangepi/rkllama/.venv/bin/rkllama_server --models /home/orangepi/rkllama-models
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

(Adjust the user and paths to the real ones.)

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now rkllama
journalctl -u rkllama -n 50
curl -s http://127.0.0.1:8080/api/tags
```

### 5. Models

Try these, in this order: **Qwen3.5-4B**, **Qwen3.5-2B**, **Gemma4-E2B**; with RAM to spare, a ~8B model (Qwen3-8B or
Qwen3.5 of that size if converted) only to compare quality.

Requirements for a `.rkllm` file:

- built for **rk3588** with **rkllm-toolkit 1.3.x** (Qwen3.5 and Gemma 4 need ≥ 1.3.0, and the runtime RKLLama
  bundles must match);
- **max_context ≥ 8192**: the app's summaries and drafts are sized for an 8192-token context;
- w8a8 (w4a16 only if memory runs short).

**A. Pre-converted from Hugging Face.** Search Hugging Face for `rk3588 rkllm Qwen3.5-4B` (and the others), read the
model card for the toolkit version and the context, then:

```bash
. ~/rkllama/.venv/bin/activate
rkllama_client pull <user>/<repo>/<file>.rkllm/qwen3.5-4b
```

**B. Converted by the user on the laptop** (rkllm-toolkit runs only on x86_64 Linux): see "On the laptop" below. The
file then goes to `~/rkllama-models/qwen3.5-4b/`.

Each model has its own folder with a `Modelfile`, e.g. `~/rkllama-models/qwen3.5-4b/Modelfile`:

```
FROM="Qwen3.5-4B_w8a8_rk3588.rkllm"
HUGGINGFACE_PATH="Qwen/Qwen3.5-4B"
SYSTEM=""
TEMPERATURE=0.7
```

RKLLama downloads the tokenizer from `HUGGINGFACE_PATH` on the first use (internet needed once). Check the Modelfile
keys against RKLLama's README of the installed version.

Qwen3.5 thinks by default: the app wants plain answers. Find how RKLLama turns thinking off for Qwen3.5 (its README has
thinking-mode settings) and note it in the report.

### 6. A first check

```bash
curl -s http://127.0.0.1:8080/api/tags | jq '.models[].name'
curl -s http://127.0.0.1:8080/api/chat -d '{"model":"qwen3.5-4b","stream":false,
  "messages":[{"role":"user","content":"Привіт! Одним реченням: що таке NPU?"}]}' | jq -r '.message.content'
# streaming, as the app calls it
curl -sN http://127.0.0.1:8080/api/chat -d '{"model":"qwen3.5-4b","stream":true,
  "messages":[{"role":"user","content":"Порахуй від 1 до 5"}]}' | head -n 5
```

Also check that `think: false` and `options.num_ctx` in a request don't make it fail (the app sends both to Ollama):

```bash
curl -s http://127.0.0.1:8080/api/chat -d '{"model":"qwen3.5-4b","stream":false,"think":false,
  "options":{"num_ctx":8192},"messages":[{"role":"user","content":"Скажи \"так\""}]}' | jq .
```

### 7. Measurements

For each model: a short prompt, and a long one of ~5k tokens (~15,000 characters of Ukrainian text; make one up, e.g.
a long fake meeting transcript of "Name: line" lines, nothing private) asking for a 5-bullet summary.

```bash
time curl -s http://127.0.0.1:8080/api/chat -d "$(jq -n --rawfile t long.txt \
  '{model:"qwen3.5-4b",stream:false,messages:[{role:"user",content:("Стисло підсумуй 5 пунктами:\n"+$t)}]}')" \
  | jq '{prompt_eval_count, prompt_eval_duration, eval_count, eval_duration}'
```

Run each twice (the first includes loading the model) and record the second. Watch the temperature meanwhile
(`cat /sys/class/thermal/thermal_zone*/temp`) and the memory (`free -h`).

## On the laptop (the user, not the Pi's agent)

### Converting a model (option B of step 5)

```bash
conda create -n rkllm python=3.11 -y && conda activate rkllm
pip install ~/rknn-llm/rkllm-toolkit/packages/rkllm_toolkit-*-cp311-*.whl   # from a clone of rknn-llm 1.3.x
huggingface-cli download Qwen/Qwen3.5-4B --local-dir ./Qwen3.5-4B
```

```python
from rkllm.api import RKLLM

llm = RKLLM()
llm.load_huggingface(model='./Qwen3.5-4B', device='cpu')
llm.build(do_quantization=True, optimization_level=0, quantized_dtype='w8a8',
          quantized_algorithm='normal', target_platform='rk3588', num_npu_core=3,
          max_context=8192)          # check the parameters against rkllm-toolkit 1.3.x's examples
llm.export_rkllm('./Qwen3.5-4B_w8a8_rk3588.rkllm')
```

Then `scp` the file to the Pi's `~/rkllama-models/qwen3.5-4b/` and write its Modelfile.

### The tunnel

`~/.ssh/config`:

```
Host orangepi
  HostName 192.168.1.50
  User orangepi
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

`~/.config/systemd/user/rkllama-tunnel.service`:

```ini
[Unit]
Description=Tunnel to RKLLama on the Orange Pi
After=network-online.target

[Service]
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N -o ExitOnForwardFailure=yes -L 11435:127.0.0.1:8080 orangepi
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
sudo apt install autossh
systemctl --user daemon-reload && systemctl --user enable --now rkllama-tunnel
curl -s http://127.0.0.1:11435/api/tags
```

### The app

Settings → Answers: provider **Ollama**, address `http://127.0.0.1:11435`, the model typed with "Another model…". Then
answers, summaries and drafts all go to the Pi; `http://127.0.0.1:11434` takes them back to the laptop.

Still to do in the app (ask Claude in the KB's repo):

- RKLLama has no `/api/show`, which the app reads models' capabilities from, so its models aren't listed (nor in
  "Try a model"): a fallback to `/api/tags`.
- A model of its own for the background work (summaries, drafts), so answers stay on the laptop.
- The 8192-token context is fixed for Ollama in the summaries and drafts: it should match the model's `max_context`.

## The report the Pi's agent gives back

1. `uname -r`, the RKNPU driver version, the RAM, the OS image.
2. What was installed and how (RKLLama version, rkllm runtime version, systemd units), and the port and bind address.
3. `sudo ufw status verbose`, and confirmation that 8080 isn't reachable from the LAN (e.g. `curl` from another host
   fails, or `ss -ltnp | grep 8080` shows `127.0.0.1`).
4. The models installed: their Hugging Face source, toolkit version, quantization and `max_context`.
5. The results of step 6: streaming works, `think: false` and `num_ctx` are accepted (or what fails, with the error),
   and how thinking is turned off for Qwen3.5.
6. Step 7's table: model, prompt tokens, prefill time, output tokens, decode tokens/s, peak temperature, memory.
7. Anything that didn't work, with the log lines.

## Sources

- [airockchip/rknn-llm](https://github.com/airockchip/rknn-llm), [its releases](https://github.com/airockchip/rknn-llm/releases),
  [benchmark.md](https://github.com/airockchip/rknn-llm/blob/main/benchmark.md)
- [NotPunchnox/rkllama](https://github.com/NotPunchnox/rkllama); the `/api/embed` bug: issue #117
- [Sngular: Qwen3 on the Orange Pi 5 NPU with RKLLama](https://www.sngular.com/insights/471/the-definitive-guide-to-deploying-qwen3-on-the-npu-of-the-orange-pi-5-pro-max-plus-ultra-using-rkllama-and-microk8s)
  (driver 0.9.6+, LFS pitfalls, cooling, w8a8 vs w4a16)
- [Radxa: RKLLM usage](https://docs.radxa.com/en/rock5/rock5b/app-development/ai/rkllm-usage)
- [CNX Software: Orange Pi 5 Plus](https://www.cnx-software.com/2023/05/10/orange-pi-5-plus-sbc-switches-to-rockchip-rk3588-soc-brings-dual-hdmi-2-1-dual-2-5gbe-m-2-pcie-sockets/)
