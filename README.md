# Lyrio Judge

[![Build Status](https://img.shields.io/github/workflow/status/lyrio-dev/judge/CI?style=flat-square)](https://github.com/lyrio-dev/judge/actions?query=workflow%3ACI)
[![Dependencies](https://img.shields.io/david/lyrio-dev/judge?style=flat-square)](https://david-dm.org/lyrio-dev/judge)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg?style=flat-square)](http://commitizen.github.io/cz-cli/)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)
[![License](https://img.shields.io/github/license/lyrio-dev/judge?style=flat-square)](LICENSE)

The judge service of Lyrio.

# Features
* Download files from server automatically.
* Run multiple tasks of multiple submissions in the same time.
* Cache compiled binary files to save judging time.
* Custom checkers with multiple interfaces for Traditional problems.
* Interaction problems with stdio or shared memory interaction interface.
* Security and resources limitting powered by [simple-sandbox](https://github.com/t123yh/simple-sandbox).
* Support multiple languages common or uncommon in competitive programming.

These features are on the plan:

* Other types of problem (Communication, ...)
* Other forms of task (Hack, CustomTest, ...)

# Deploying
You need a Linux system with:

* Kernel booted with `cgroup_enable=memory swapaccount=1`.
* A C++ 17 compiler (e.g. `g++-8` or `clang++-8`).
* CMake 3.8 or later.
* A sandbox [rootfs](#Sandbox-Rootfs).

Clone the git repo (`--recursive` is required for git submodules):

```bash
$ git clone git@github.com:lyrio-dev/judge.git lyrio-judge --recursive
$ cd lyrio-judge
```

Install the dependency `libfmt-dev`. On Ubuntu:

```bash
$ apt install libfmt-dev
```

You may need to specify `CXX` environment variable to build with your C++ 17 compiler:

```bash
$ export CXX=g++-8
$ CMAKE_POLICY_VERSION_MINIMUM=3.5 yarn install --frozen-lockfile
$ cp config-example.yaml config.yaml
```

On CMake 4, the environment variable lets the locked `simple-sandbox` dependency configure its native build with policy compatibility at 3.5. CI and automatic deployment set it during dependency installation.

Add a judge client to your Lyrio backend server with `/api/judgeClient/addJudgeClient` and copy the `key` in the response.

Create a copy of the config file, then edit it:

```yaml
// The server url without "/api"
serverUrl: http://lyrio.test/
// The key of this judge client from Lyrio backend server
key: 40uXJPXzuO2Ha41iuh8Pjw1h0ahvP9i/zJk7Rtn/
// The path to store files downloaded from server, will be created if not exists
dataStore: /root/judge/data
// The path to store compiled binaries, will be created if not exists
// WILL be emptied on each start
binaryCacheStore: /root/judge/cache
// The max size of the path above
// Note that it's "soft limit", if a binary is disposed from the cache but currently using
// it will not be deleted before releasing and new binaries will still added
binaryCacheMaxSize: 536870912
// The number of judge tasks consuming in the same time (a judge task is something like a submission)
taskConsumingThreads: 2
// The number of files downloading in the same time
maxConcurrentDownloads: 10
// The number of run tasks in the same time (a run task is something like compiling code or running a testcase)
// Each run task need a separated working directory
// It's recommended to ues unique tmpfs mount point for each task to have better output size limiting and performance
maxConcurrentTasks: 3
// The timeout for RPC operations with server
rpcTimeout: 20000
// The timeout of downloading a file from testdata or user-uploaded answer
downloadTimeout: 20000
// The maximum times of retrying after a download failure (including timeout)
downloadRetry: 3
taskWorkingDirectories:
  - /root/judge/1
  - /root/judge/2
  - /root/judge/3
sandbox:
  // The sandbox rootfs (see the "Sandbox RootFS" section of README)
  rootfs: /opt/rootfs-ng
  // The user to use in the sandbox
  // Do NOT modify it unless you know what you're doing
  user: sandbox
  // The hostname inside the sandbox. Leave null to use the same as the outside hostname
  hostname: null
  // The environment variables for the sandbox
  // Do NOT modify it unless you know what you're doing
  environments:
    PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    HOME: /sandbox
    LC_ALL: en_US.UTF-8
```

Start it with:

```
$ LYRIO_JUDGE_CONFIG_FILE=./config.yaml yarn start
```

## NSOJ 自动部署

推送到 `main` 后，[CI](.github/workflows/ci.yml) 通过才启动部署。Actions 上传该提交和 `vendor/testlib`，Linux 服务器安装锁定依赖并编译原生模块。构建成功后切换 `/opt/nsoj-judge` 指向的发布目录，再用 root 的 PM2 重启 `nsoj-judge`。PM2 的 PID 和工作目录检查失败时，部署脚本会切回上一版本。

### 一次性准备服务器

以下命令用于现有服务的工作目录为 `/opt/nsoj-judge`、启动时读取该目录下的 `config.yaml`、由 root 的 `/usr/bin/pm2` 管理且服务名为 `nsoj-judge` 的服务器。使用部署账号登录后执行。它会保留原工作树并创建初始发布链接，PM2 继续使用原工作目录路径。

```bash
(
  set -e
  active=/opt/nsoj-judge
  releases=/opt/nsoj-judge-releases
  test -d "$active" && test ! -L "$active" && test ! -e "$releases/baseline" || exit 1
  sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 "$releases"
  install -m 0600 "$active/config.yaml" "$releases/config.yaml"
  sudo -n mv -T -- "$active" "$releases/baseline"
  if ! sudo -n ln -s -- "$releases/baseline" "$active"; then
    sudo -n mv -T -- "$releases/baseline" "$active"
    exit 1
  fi
  readlink -f "$active"
  sudo -H -n /usr/bin/pm2 pid nsoj-judge
)
```

后续版本读取 `/opt/nsoj-judge-releases/config.yaml`。配置中的 rootfs、数据、缓存和评测工作目录使用服务器上的绝对路径。部署账号需要可用的 Node、Yarn、编译工具、`flock`，以及切换 `/opt/nsoj-judge` 和重启 root PM2 进程的非交互 sudo 权限。

### 一次性配置 GitHub

1. 在本机为 Actions 生成独立的部署密钥，将公钥加入服务器部署账号。在 NSOJ 服务器上用 `lee` 和端口 `23581`。

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'nsoj-judge-actions' -f ~/.ssh/nsoj-judge-actions
   ssh-copy-id -i ~/.ssh/nsoj-judge-actions.pub -p 23581 lee@nsoj.top
   ssh -i ~/.ssh/nsoj-judge-actions -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -p 23581 lee@nsoj.top 'id -un'
   ```

2. 打开 Judge 仓库的 **Settings → Secrets and variables → Actions**，添加以下 Repository secrets。`SERVER_KNOWN_HOSTS` 使用本机已验证的主机密钥记录。

   | Secret | NSOJ 示例 |
   | --- | --- |
   | `SERVER_HOST` | `nsoj.top` |
   | `SERVER_PORT` | `23581` |
   | `SERVER_USER` | `lee` |
   | `SERVER_SSH_KEY` | `~/.ssh/nsoj-judge-actions` 文件内容 |
   | `SERVER_KNOWN_HOSTS` | `ssh-keygen -F '[nsoj.top]:23581' -f ~/.ssh/known_hosts` 输出中去掉 `#` 开头的行 |

3. 将工作流提交推送到 `main`。在 **Actions → CI → deploy** 查看首发结果，然后到后端确认评测机已上线并提交一道最小题。PM2 检查覆盖进程启动，实际评测验证后端连接和沙箱。

部署成功时日志会输出上一版本路径。需要人工回滚时，等部署结束后在服务器将 `/opt/nsoj-judge` 链接切回该路径，再执行 `sudo -H -n /usr/bin/pm2 restart nsoj-judge`。确认新版可用后，可清理已经不用的发布目录。`baseline` 保存原工作树。

# Parallel Judging
You can run multiple judge clients with different key on multiple machines.

You don't need (and are not expected) to run multiple instances of judge client on the same machine (except for testing purpose). Use `taskConsumingThreads` and `maxConcurrentTasks` options if you want to do parallel judging on one machine.

If you run multiple judge clients on the same machine for some testing purpose, make sure you specfied different `dataStore`, `binaryCacheStore` and `taskWorkingDirectories` for them.

NEVER run multiple judge clients with the same `key` -- thay will conflit and none of them can consume tasks at all.

# Sandbox RootFS
The use of sandbox rootfs is aimed to isolate the access of user programs (and compiles) from the main system, to prevent some sensitive information to be stolen by user.

You may download the official [sandbox-rootfs](https://github.com/lyrio-dev/sandbox-rootfs) directly from release or bootstrap it by yourself. You can also build a custom rootfs with your favorite disto.
