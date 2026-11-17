#!/bin/sh
# M2, NOT YET RUN (the build was blocked by the permission system in the beta session): decode-only LGPL FFmpeg for video2gpx.
# Source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz, sha256 b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3
# (the same hash as Homebrew's formula). Needs: pkg-config, nasm (optional on arm64), `brew install dav1d`.
#   mkdir -p build/ffmpeg && cd build/ffmpeg && tar xf ffmpeg-8.1.1.tar.xz && cd ffmpeg-8.1.1 && ../../../scripts/ffmpeg-decode-only.sh
set -eu
export PKG_CONFIG_PATH="$(brew --prefix dav1d)/lib/pkgconfig"
./configure --prefix="$PWD/../out" --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-network \
  --disable-ffplay --enable-ffmpeg --enable-ffprobe --enable-pic --enable-zlib \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,matroska,avi,mpegts,mpegps,mpegvideo,h264,hevc,ivf,m4v \
  --enable-parser=h264,hevc,av1,vp9,vp8,mpeg4video,mpegvideo \
  --enable-decoder=h264,hevc,vp9,vp8,mpeg4,mpeg2video,mjpeg \
  --enable-libdav1d --enable-decoder=libdav1d \
  --enable-videotoolbox --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,vp9_videotoolbox,av1_videotoolbox,mpeg4_videotoolbox,mpeg2_videotoolbox \
  --enable-filter=scale,format,select,framestep,showinfo,null,fps \
  --enable-muxer=rawvideo,image2,mjpeg,null --enable-encoder=mjpeg,rawvideo \
  --enable-bsf=null,h264_mp4toannexb,hevc_mp4toannexb
make -j4 && make install
# then copy out/bin/ffmpeg and out/bin/ffprobe plus libdav1d.7.dylib next to them and fix the load path:
#   install_name_tool -change "$(brew --prefix dav1d)/lib/libdav1d.7.dylib" @loader_path/libdav1d.7.dylib out/bin/ffmpeg   (same for ffprobe)
