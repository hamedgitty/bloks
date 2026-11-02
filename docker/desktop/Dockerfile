# syntax=docker/dockerfile:1
# Written by desktopServiceDockerfile() in server/local-vm.ts; change it
# there. An agent's own Linux desktop, run beside Bloks (docs/DOCKER.md).
FROM docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b
USER root
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) url='https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl'; sum='f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961'; whl='/tmp/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl' ;; \
      aarch64|arm64) url='https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl'; sum='48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77'; whl='/tmp/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl' ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "$url" -o "$whl"; \
    echo "$sum  $whl" | sha256sum -c -; \
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$whl"; \
    rm -f "$whl"; \
    bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \
    test -n "$bin"; \
    install -D -m 0755 "$bin" /usr/local/libexec/bloks/cua-driver; \
    install -d -o cua -g cua -m 0700 /home/cua/workspace; \
    test "$(/usr/local/libexec/bloks/cua-driver --version)" = "cua-driver 0.20.0"
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'ws=/home/cua/workspace' \
      'profiles="$ws/.browser-profiles"' \
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \
      'chmod 0700 "$ws" "$profiles" "$profiles/google-chrome" "$profiles/chromium"' \
      'keep() {' \
      '  src="$HOME/.config/$1"; dst="$profiles/$1"' \
      '  if [ -d "$src" ] && [ ! -L "$src" ] && [ -z "$(find "$dst" -mindepth 1 -print -quit)" ]; then cp -a "$src"/. "$dst"/; fi' \
      '  rm -rf "$src"; ln -s "$dst" "$src"' \
      '}' \
      'keep google-chrome' \
      'keep chromium' \
      'find "$profiles" \( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \) -delete' \
      > /usr/local/bin/bloks-workspace.sh \
    && chmod 0755 /usr/local/bin/bloks-workspace.sh
RUN printf '%s\n' \
      '#!/bin/sh' \
      '/usr/local/bin/bloks-workspace.sh' \
      'n=0' \
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \
      '  n=$((n + 1))' \
      '  if [ "$n" -ge 45 ]; then echo "X display :1 not ready after 45s" >&2; exit 1; fi' \
      '  sleep 1' \
      'done' \
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 /usr/local/libexec/bloks/cua-driver serve --socket /run/user/1000/bloks-cua.sock --permission-mode standard' \
      > /usr/local/bin/bloks-driver.sh \
    && chmod 0755 /usr/local/bin/bloks-driver.sh
RUN printf '%s\n' \
      '' \
      '[program:bloks-cua-driver]' \
      'command=/usr/local/bin/bloks-driver.sh' \
      'user=cua' \
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \
      'autorestart=true' \
      'startsecs=2' \
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \
      'priority=30' \
      >> /etc/supervisor/supervisord.conf
LABEL dev.bloks.vm="1" \
      dev.bloks.vm-driver="0.20.0" \
      dev.bloks.vm-base="sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b" \
      dev.bloks.vm-layer="1"
COPY --chmod=0755 <<'EOF' /usr/local/bin/bloks-desktop-start.sh
#!/bin/sh
set -eu
if [ -z "${VNC_PW:-}" ]; then
  VNC_PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
fi
# written as the desktop's own account: with every capability dropped,
# root here cannot write into a folder that is not its own
printf '%s' "$VNC_PW" | setpriv --reuid=cua --regid=cua --init-groups sh -c 'umask 077; cat > /run/bloks-desktop/viewer-password'
export VNC_PW
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
EOF
RUN install -d -o cua -g cua -m 0700 /run/bloks-desktop
COPY --chmod=0755 <<'EOF' /usr/local/libexec/bloks/desktop-service.py
import base64, json, os, socketserver, subprocess, threading

DRIVER = "/usr/local/libexec/bloks/cua-driver"
SOCKET = "/run/user/1000/bloks-cua.sock"
ENV = dict(os.environ, HOME="/home/cua", USER="cua", DISPLAY=":1",
           CUA_DRIVER_INSTALL_CHANNEL="python_package", CUA_DRIVER_RS_TELEMETRY_ENABLED="0")
SHOT = "/tmp/bloks-preview.png"
ONCE = {
    "version": [DRIVER, "--version"],
    "health": [DRIVER, "call", "health_report", "{}", "--socket", SOCKET],
    "log": ["tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
}

def run(argv, timeout):
    try:
        done = subprocess.run(argv, env=ENV, capture_output=True, timeout=timeout)
        return done.returncode == 0, done.stdout, done.stderr
    except Exception as error:
        return False, b"", str(error).encode()

class Ask(socketserver.StreamRequestHandler):
    def answer(self, ok, out=b"", err=b""):
        text = lambda b: b.decode("utf-8", "replace") if isinstance(b, bytes) else b
        self.wfile.write(json.dumps({"ok": ok, "stdout": text(out), "stderr": text(err)[-600:]}).encode())

    def handle(self):
        line = self.rfile.readline(256)
        try:
            op = json.loads(line).get("op")
        except Exception:
            return self.answer(False, err="not a question")
        if op in ONCE:
            return self.answer(*run(ONCE[op], 15))
        if op == "password":
            try:
                with open("/run/bloks-desktop/viewer-password") as kept:
                    return self.answer(True, kept.read().strip())
            except OSError as error:
                return self.answer(False, err=str(error))
        if op == "screenshot":
            ok, _, err = run([DRIVER, "call", "get_desktop_state", "{}", "--socket", SOCKET, "--screenshot-out-file", SHOT], 30)
            if not ok:
                return self.answer(False, err=err)
            with open(SHOT, "rb") as frame:
                return self.answer(True, base64.b64encode(frame.read()))
        if op == "mcp":
            driver = subprocess.Popen([DRIVER, "mcp", "--socket", SOCKET], env=ENV,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            def out():
                for chunk in iter(lambda: driver.stdout.read1(65536), b""):
                    self.wfile.write(chunk)
                    self.wfile.flush()
                self.connection.close()
            threading.Thread(target=out, daemon=True).start()
            try:
                for chunk in iter(lambda: self.rfile.read1(65536), b""):
                    driver.stdin.write(chunk)
                    driver.stdin.flush()
            except OSError:
                pass
            driver.kill()
            return
        self.answer(False, err="not something this desktop answers")

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

Server(("0.0.0.0", 7301), Ask).serve_forever()
EOF
RUN printf '%s\n' \
      '' \
      '[program:bloks-desktop-service]' \
      'command=/opt/venv/bin/python /usr/local/libexec/bloks/desktop-service.py' \
      'user=cua' \
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \
      'autorestart=true' \
      'stdout_logfile=/var/log/supervisor/bloks-desktop-service.log' \
      'stderr_logfile=/var/log/supervisor/bloks-desktop-service.error.log' \
      'priority=40' \
      >> /etc/supervisor/supervisord.conf
LABEL dev.bloks.desktop-service="1"
EXPOSE 7301
CMD ["/usr/local/bin/bloks-desktop-start.sh"]
