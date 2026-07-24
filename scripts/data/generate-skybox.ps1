param(
  [int]$FaceSize = 2048
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = Join-Path $PSScriptRoot "..\..\assets\milky-way-panorama-hires.jpg"
$outputDirectory = Join-Path $PSScriptRoot "..\..\assets\skybox"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class SkyboxGenerator
{
    private static readonly string[] Faces = {
        "positive-x", "negative-x", "positive-y",
        "negative-y", "positive-z", "negative-z"
    };

    public static void Generate(string sourcePath, string outputDirectory, int size)
    {
        using (var original = new Bitmap(sourcePath))
        using (var panorama = new Bitmap(
            original.Width,
            original.Height,
            PixelFormat.Format24bppRgb))
        {
            if (original.Width != original.Height * 2)
                throw new InvalidOperationException(
                    string.Format("Expected a 2:1 panorama, got {0}x{1}.", original.Width, original.Height));

            using (var graphics = Graphics.FromImage(panorama))
                graphics.DrawImageUnscaled(original, 0, 0);

            var sourceRectangle = new Rectangle(0, 0, panorama.Width, panorama.Height);
            var sourceData = panorama.LockBits(
                sourceRectangle,
                ImageLockMode.ReadOnly,
                PixelFormat.Format24bppRgb);
            var sourceBytes = new byte[sourceData.Stride * panorama.Height];
            Marshal.Copy(sourceData.Scan0, sourceBytes, 0, sourceBytes.Length);
            panorama.UnlockBits(sourceData);

            foreach (var face in Faces)
                GenerateFace(
                    face,
                    sourceBytes,
                    panorama.Width,
                    panorama.Height,
                    sourceData.Stride,
                    outputDirectory,
                    size);
        }
    }

    private static void GenerateFace(
        string face,
        byte[] source,
        int sourceWidth,
        int sourceHeight,
        int sourceStride,
        string outputDirectory,
        int size)
    {
        using (var output = new Bitmap(size, size, PixelFormat.Format24bppRgb))
        {
            var outputRectangle = new Rectangle(0, 0, size, size);
            var outputData = output.LockBits(
                outputRectangle,
                ImageLockMode.WriteOnly,
                PixelFormat.Format24bppRgb);
            var outputBytes = new byte[outputData.Stride * size];

            for (var row = 0; row < size; row++)
            {
                var v = 2.0 * (row + 0.5) / size - 1.0;
                for (var column = 0; column < size; column++)
                {
                    var u = 2.0 * (column + 0.5) / size - 1.0;
                    double x, y, z;
                    Direction(face, u, v, out x, out y, out z);

                    var magnitude = Math.Sqrt(x * x + y * y + z * z);
                    var longitude = Math.Atan2(z, x);
                    var latitude = Math.Asin(y / magnitude);
                    var sourceX = (longitude / (2.0 * Math.PI) + 0.5) * sourceWidth;
                    var sourceY = (0.5 - latitude / Math.PI) * sourceHeight;

                    SampleBilinear(
                        source,
                        sourceWidth,
                        sourceHeight,
                        sourceStride,
                        sourceX,
                        sourceY,
                        outputBytes,
                        row * outputData.Stride + column * 3);
                }
            }

            Marshal.Copy(outputBytes, 0, outputData.Scan0, outputBytes.Length);
            output.UnlockBits(outputData);

            var encoder = FindEncoder(ImageFormat.Jpeg);
            using (var parameters = new EncoderParameters(1))
            {
                parameters.Param[0] = new EncoderParameter(
                    System.Drawing.Imaging.Encoder.Quality,
                    88L);
                output.Save(
                    Path.Combine(outputDirectory, string.Format("milky-way-{0}.jpg", face)),
                    encoder,
                    parameters);
            }
        }
    }

    private static void Direction(
        string face,
        double u,
        double v,
        out double x,
        out double y,
        out double z)
    {
        switch (face)
        {
            case "positive-x": x = 1.0; y = -v; z = -u; break;
            case "negative-x": x = -1.0; y = -v; z = u; break;
            case "positive-y": x = u; y = 1.0; z = v; break;
            case "negative-y": x = u; y = -1.0; z = -v; break;
            case "positive-z": x = u; y = -v; z = 1.0; break;
            default: x = -u; y = -v; z = -1.0; break;
        }
    }

    private static void SampleBilinear(
        byte[] source,
        int width,
        int height,
        int stride,
        double x,
        double y,
        byte[] destination,
        int destinationOffset)
    {
        var xFloor = Math.Floor(x);
        var yFloor = Math.Floor(y);
        var x0 = ((int)xFloor % width + width) % width;
        var y0 = Math.Max(0, Math.Min((int)yFloor, height - 1));
        var x1 = (x0 + 1) % width;
        var y1 = Math.Min(y0 + 1, height - 1);
        var xFraction = x - xFloor;
        var yFraction = y - yFloor;

        var offsets = new[] {
            y0 * stride + x0 * 3,
            y0 * stride + x1 * 3,
            y1 * stride + x0 * 3,
            y1 * stride + x1 * 3
        };

        for (var channel = 0; channel < 3; channel++)
        {
            var top = source[offsets[0] + channel] * (1.0 - xFraction)
                + source[offsets[1] + channel] * xFraction;
            var bottom = source[offsets[2] + channel] * (1.0 - xFraction)
                + source[offsets[3] + channel] * xFraction;
            destination[destinationOffset + channel] = (byte)Math.Round(
                top * (1.0 - yFraction) + bottom * yFraction);
        }
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

[SkyboxGenerator]::Generate(
  (Resolve-Path $source),
  (Resolve-Path $outputDirectory),
  $FaceSize
)
