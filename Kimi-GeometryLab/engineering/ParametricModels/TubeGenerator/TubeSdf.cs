using System.Numerics;
using PicoGK;

namespace TubeGenerator;

public sealed class TubeSdf : IBoundedImplicit
{
    public float OuterRadius { get; }
    public float InnerRadius { get; }
    public float Length { get; }

    public BBox3 oBounds { get; }

    public TubeSdf(
        float outerRadius,
        float innerRadius,
        float length,
        float boundsMargin)
    {
        if (outerRadius <= 0)
            throw new ArgumentOutOfRangeException(nameof(outerRadius));

        if (innerRadius <= 0 || innerRadius >= outerRadius)
            throw new ArgumentOutOfRangeException(nameof(innerRadius));

        if (length <= 0)
            throw new ArgumentOutOfRangeException(nameof(length));

        if (boundsMargin <= 0)
            throw new ArgumentOutOfRangeException(nameof(boundsMargin));

        OuterRadius = outerRadius;
        InnerRadius = innerRadius;
        Length = length;

        float extent = outerRadius + boundsMargin;
        float halfLength = length * 0.5f + boundsMargin;

        oBounds = new BBox3(
            -extent, -extent, -halfLength,
             extent,  extent,  halfLength
        );
    }

    public float fSignedDistance(in Vector3 point)
    {
        float outer = CylinderSdf(
            point,
            OuterRadius,
            Length
        );

        float inner = CylinderSdf(
            point,
            InnerRadius,
            Length
        );

        // Difference: outer cylinder minus inner cylinder.
        return MathF.Max(outer, -inner);
    }

    private static float CylinderSdf(
        in Vector3 point,
        float radius,
        float length)
    {
        float radialDistance =
            MathF.Sqrt(
                point.X * point.X +
                point.Y * point.Y
            ) - radius;

        float axialDistance =
            MathF.Abs(point.Z) - length * 0.5f;

        float outsideX = MathF.Max(radialDistance, 0.0f);
        float outsideY = MathF.Max(axialDistance, 0.0f);

        float outsideDistance =
            MathF.Sqrt(
                outsideX * outsideX +
                outsideY * outsideY
            );

        float insideDistance =
            MathF.Min(
                MathF.Max(radialDistance, axialDistance),
                0.0f
            );

        return outsideDistance + insideDistance;
    }
}
