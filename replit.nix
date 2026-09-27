{ pkgs }: {
  deps = [
    pkgs.nodejs_20

    # Python is here for tower/bridge.py, which server.ts spawns when
    # BRIDGE_INSTANCE is set. numpy and websockets come from Nix rather than
    # from pip on purpose: pip installs into a writable store that Replit
    # rebuilds, so a pip-installed dependency can vanish between restarts and
    # take the tower dark with it. Declared here they are part of the image.
    pkgs.python311
    pkgs.python311Packages.numpy
    pkgs.python311Packages.websockets

    # avr-vad (Silero) and @ffmpeg-installer/ffmpeg are native. If the VAD
    # fails to load, startRecordingSession() falls back to a 5-second timer on
    # its own, so the pipeline still works — set USE_VAD=false to skip the
    # attempt entirely and avoid the startup delay.
    pkgs.ffmpeg
  ];
}
