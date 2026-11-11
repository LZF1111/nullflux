import subprocess, sys
import imageio_ffmpeg
src, dst = sys.argv[1], sys.argv[2]
speed, fps, width = float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
vf = ('setpts=PTS/%g,fps=%d,scale=%d:-1:flags=lanczos,split[a][b];'
      '[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle') % (speed, fps, width)
cmd = [imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-v', 'error', '-i', src, '-filter_complex', vf, '-loop', '0', dst]
subprocess.run(cmd, check=True)
print('ok')
