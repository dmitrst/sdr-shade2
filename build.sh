# Rebuild the Image:
docker build --platform linux/arm64 --build-arg SERIAL=4448f6ec9ed1b146 -t sdr-builder-arm64 .
# Extract Files:
docker run --platform linux/arm64 -d --name sdr-build-container sdr-builder-arm64 tail -f /dev/null
docker cp sdr-build-container:/extract/sdr-server .
docker cp sdr-build-container:/extract/config.json .  # Optional: Verify the generated key
docker cp sdr-build-container:/extract/debug.log .   # Optional
docker stop sdr-build-container
docker rm sdr-build-container