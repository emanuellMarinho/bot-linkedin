#!/usr/bin/env python3
"""Local POSIX PTY smoke. Uses synthetic data, no sources or messaging service.

Windows executable validation remains in the Windows workflow; this test checks
the interactive terminal contract without pretending to press Windows keys.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time


def main():
    directory = Path(tempfile.mkdtemp(prefix="vaga-terminal-ux-"))
    root = Path(__file__).resolve().parents[1]
    config = directory / "bot.config.json"
    config.write_text(json.dumps({
        "setup": {"completed": True, "version": 1},
        "dataDir": "./data",
        "sources": [],
        "preferences": {"collectionEnabled": False},
        "workWindow": {"enabled": False},
        "notifications": {"channel": "terminal", "requireConnection": True},
        "whatsapp": {"enabled": False},
    }), encoding="utf8")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 60, 0, 0))
    process = subprocess.Popen(
        ["node", "src/bot.js", "--config", str(config)], cwd=root,
        stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        env={**os.environ, "TERM": "xterm", "NO_COLOR": "1"},
    )
    os.close(slave)
    transcript = ""
    cursor = 0

    def expect(pattern, timeout=20):
        nonlocal transcript, cursor
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = re.search(pattern, transcript[cursor:], re.IGNORECASE)
            if found:
                cursor += found.end()
                return
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    value = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not value:
                    break
                transcript += value.decode("utf8", errors="replace")
            if process.poll() is not None:
                break
        raise AssertionError(f"Missing terminal text {pattern!r}:\n{transcript}")

    try:
        expect(r"ACOMPANHAR")
        expect(r"Comando >")
        os.write(master, b"1\n")
        expect(r"Nenhuma vaga encontrada")
        os.write(master, b"2\n")
        expect(r"Nenhuma candidatura iniciada")
        os.write(master, b"3\n")
        expect(r"Nenhuma pergunta aguardando resposta")
        os.write(master, b"0\n")
        assert process.wait(timeout=10) == 0
        assert not (directory / "data" / "whatsapp-session").exists()
        print("PASS: PTY 60 colunas, menu 1/2/3, resposta sequencial e encerrar 0; sem rede/envios.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
