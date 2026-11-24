using System;
using System.IO;
using PicoGK;

namespace TubeGenerator;

internal static class Program
{
    private static int Main()
    {
        const float voxelSize = 0.5f;
        const float outerRadius = 20.0f;
        const float innerRadius = 15.0f;
        const float length = 100.0f;
        const float boundsMargin = voxelSize * 2.0f;

        string outputDirectory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "Kimi-GeometryLab",
            "results");

        string stlPath = Path.Combine(outputDirectory, "tube.stl");

        try
        {
            Directory.CreateDirectory(outputDirectory);

            Console.WriteLine("Kimi-GeometryLab - Headless Tube Generator");
            Console.WriteLine($"Voxel size: {voxelSize} mm");
            Console.WriteLine($"Outer radius: {outerRadius} mm");
            Console.WriteLine($"Inner radius: {innerRadius} mm");
            Console.WriteLine($"Length: {length} mm");

            // Create PicoGK without Library.Go() or a graphical viewer.
            using var library = new Library(voxelSize);

            var tube = new TubeSdf(
                outerRadius,
                innerRadius,
                length,
                boundsMargin);

            // Explicitly associate geometry with this Library instance.
            var voxels = new Voxels(library, tube);
            var mesh = new Mesh(voxels);

            mesh.SaveToStlFile(stlPath);

            var fileInfo = new FileInfo(stlPath);

            if (!fileInfo.Exists || fileInfo.Length == 0)
                throw new IOException("STL was not created or is empty.");

            Console.WriteLine($"STL created: {stlPath}");
            Console.WriteLine($"File size: {fileInfo.Length} bytes");
            Console.WriteLine("Geometry generation completed.");

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Tube generation failed:");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }
}
