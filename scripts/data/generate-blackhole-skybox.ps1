# Derives the black hole simulator's equirectangular sky texture from the same
# ESO/S. Brunier Milky Way panorama the globe already ships
# (assets/milky-way-panorama-hires.jpg, CC BY 4.0, 6000x3000).
#
# Two reasons this is not a one-line GDI+ DrawImage:
#
#  1. The panorama is mostly point sources. Averaging pixels in sRGB space
#     loses flux non-linearly, and a downsampled starfield comes out visibly
#     dimmer than the original with the bright cores flattened. The resample
#     below decodes sRGB to linear light, area-averages there, and re-encodes
#     -- the same "shift in linear light" discipline the simulator's shader
#     applies to the sky (spec §5, §6.2).
#  2. GDI+'s HighQualityBicubic is a sharpening kernel; on a starfield it rings
#     around every bright pixel. A box (area-average) filter is the correct
#     downsample when the ratio is >1 and adds nothing that was not there.
#
# Output: blackhole-sim/public/textures/milky-way-eso-4k.jpg
#
#   pwsh scripts/data/generate-blackhole-skybox.ps1
#   pwsh scripts/data/generate-blackhole-skybox.ps1 -Width 2048 -Quality 90
#
# Cesium's cube map for the globe comes from the same source via
# generate-skybox.ps1; this one stays equirectangular because the simulator
# samples it directly from an escaped ray direction rather than through a
# cube-map lookup.

param(
  [int]$Width = 4096,
  [long]$Quality = 92
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = Join-Path $PSScriptRoot "..\..\assets\milky-way-panorama-hires.jpg"
$outputDirectory = Join-Path $PSScriptRoot "..\..\blackhole-sim\public\textures"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory "milky-way-eso-4k.jpg"

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class EquirectDownsampler
{
    public static void Run(string sourcePath, string outputPath, int width, long quality)
    {
        int height = width / 2;

        using (var original = new Bitmap(sourcePath))
        {
            if (original.Width != original.Height * 2)
                throw new InvalidOperationException(string.Format(
                    "Expected a 2:1 equirectangular panorama, got {0}x{1}.",
                    original.Width, original.Height));
            if (original.Width < width)
                throw new InvalidOperationException(string.Format(
                    "Refusing to upsample: source is {0} px wide, requested {1}.",
                    original.Width, width));

            int sourceWidth = original.Width;
            int sourceHeight = original.Height;

            // Force a known pixel layout; the source may decode as any format.
            using (var panorama = new Bitmap(sourceWidth, sourceHeight, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(panorama))
                    graphics.DrawImageUnscaled(original, 0, 0);

                var rectangle = new Rectangle(0, 0, sourceWidth, sourceHeight);
                var locked = panorama.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                var bytes = new byte[locked.Stride * sourceHeight];
                Marshal.Copy(locked.Scan0, bytes, 0, bytes.Length);
                int stride = locked.Stride;
                panorama.UnlockBits(locked);

                var toLinear = new float[256];
                for (int i = 0; i < 256; i++)
                    toLinear[i] = SrgbToLinear(i / 255.0f);

                // Horizontal pass: sourceWidth -> width, in linear light.
                var horizontal = new float[width * sourceHeight * 3];
                Resample1D(
                    delegate(int row, int column, int channel) {
                        // Format24bppRgb is stored B, G, R.
                        return toLinear[bytes[row * stride + column * 3 + (2 - channel)]];
                    },
                    horizontal, sourceWidth, width, sourceHeight, width, true);

                // Vertical pass: sourceHeight -> height, still in linear light.
                var vertical = new float[width * height * 3];
                Resample1D(
                    delegate(int column, int row, int channel) {
                        return horizontal[(row * width + column) * 3 + channel];
                    },
                    vertical, sourceHeight, height, width, width, false);

                using (var result = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                {
                    var outRectangle = new Rectangle(0, 0, width, height);
                    var outLocked = result.LockBits(outRectangle, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                    var outBytes = new byte[outLocked.Stride * height];

                    for (int row = 0; row < height; row++)
                        for (int column = 0; column < width; column++)
                            for (int channel = 0; channel < 3; channel++)
                            {
                                float linear = vertical[(row * width + column) * 3 + channel];
                                byte encoded = (byte)Math.Max(0, Math.Min(255,
                                    (int)Math.Round(LinearToSrgb(linear) * 255.0f)));
                                outBytes[row * outLocked.Stride + column * 3 + (2 - channel)] = encoded;
                            }

                    Marshal.Copy(outBytes, 0, outLocked.Scan0, outBytes.Length);
                    result.UnlockBits(outLocked);

                    using (var parameters = new EncoderParameters(1))
                    {
                        parameters.Param[0] = new EncoderParameter(
                            System.Drawing.Imaging.Encoder.Quality, quality);
                        result.Save(outputPath, FindEncoder(ImageFormat.Jpeg), parameters);
                    }
                }
            }
        }
    }

    private delegate float Sampler(int line, int position, int channel);

    /// <summary>
    /// Area-average resample of one axis with fractional edge coverage, so a
    /// non-integer ratio (6000 -> 4096 is 1.4648...) still conserves total
    /// linear-light flux rather than dropping or double-counting rows.
    /// </summary>
    private static void Resample1D(
        Sampler sample,
        float[] destination,
        int sourceLength,
        int destinationLength,
        int lineCount,
        int destinationRowLength,
        bool lineIsRow)
    {
        double scale = (double)sourceLength / destinationLength;

        for (int line = 0; line < lineCount; line++)
            for (int index = 0; index < destinationLength; index++)
            {
                double start = index * scale;
                double end = start + scale;
                int first = (int)Math.Floor(start);
                int last = (int)Math.Ceiling(end) - 1;
                if (last >= sourceLength) last = sourceLength - 1;

                double r = 0.0, g = 0.0, b = 0.0, total = 0.0;
                for (int position = first; position <= last; position++)
                {
                    double weight = Math.Min(end, position + 1) - Math.Max(start, position);
                    if (weight <= 0.0) continue;
                    r += weight * sample(line, position, 0);
                    g += weight * sample(line, position, 1);
                    b += weight * sample(line, position, 2);
                    total += weight;
                }

                if (total <= 0.0) total = 1.0;
                // The horizontal pass walks rows and writes columns; the
                // vertical pass walks columns and writes rows.
                int offset = lineIsRow
                    ? (line * destinationRowLength + index) * 3
                    : (index * destinationRowLength + line) * 3;
                destination[offset] = (float)(r / total);
                destination[offset + 1] = (float)(g / total);
                destination[offset + 2] = (float)(b / total);
            }
    }

    private static float SrgbToLinear(float c)
    {
        return c <= 0.04045f ? c / 12.92f : (float)Math.Pow((c + 0.055) / 1.055, 2.4);
    }

    private static float LinearToSrgb(float c)
    {
        if (c <= 0.0f) return 0.0f;
        if (c >= 1.0f) return 1.0f;
        return c <= 0.0031308f ? c * 12.92f : (float)(1.055 * Math.Pow(c, 1.0 / 2.4) - 0.055);
    }

    private static ImageCodecInfo FindEncoder(ImageFormat format)
    {
        foreach (var encoder in ImageCodecInfo.GetImageEncoders())
            if (encoder.FormatID == format.Guid)
                return encoder;
        throw new InvalidOperationException("JPEG encoder is unavailable.");
    }
}
'@

Write-Host "Resampling $(Split-Path -Leaf $source) to ${Width}x$($Width / 2) in linear light..."
[EquirectDownsampler]::Run((Resolve-Path $source), $output, $Width, $Quality)

$size = (Get-Item $output).Length
Write-Host ("Wrote {0} ({1:N1} MB)" -f $output, ($size / 1MB))
