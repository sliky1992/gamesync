using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameSync.Client;

/// <summary>
/// Local file operations: deterministic content hashing, zipping a save folder,
/// and safely applying a downloaded zip onto a save folder.
/// </summary>
public static class SyncEngine
{
    /// <summary>
    /// Name of the sidecar entry stored *inside* the save zip that records
    /// per-file/-dir metadata (attributes + creation/last-write time) the zip
    /// container itself can't carry. Stripped before the save is applied, so it
    /// never lands in the game's save folder and never affects the content hash.
    /// </summary>
    private const string MetaEntry = ".gamesync-meta.v1.json";

    /// <summary>One entry in the metadata sidecar. Times are UTC ticks.</summary>
    private record FileMeta(string Rel, bool IsDir, int Attributes, long CreationUtc, long LastWriteUtc);


    /// <summary>
    /// A stable, order-independent hash of a folder's contents. Independent of
    /// the zip container (timestamps/ordering), so the same save on two machines
    /// produces the same hash. Format: for each file, sorted by relative path,
    /// append "relPath\nsize\nfileSha256\n"; the SHA-256 of that manifest is the
    /// content hash. Returns "" when the path is missing or empty (no save yet).
    /// </summary>
    public static string ComputeContentHash(string path)
    {
        var entries = new List<(string Rel, long Size, string Hash)>();

        if (Directory.Exists(path))
        {
            foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(path, file).Replace('\\', '/');
                entries.Add((rel, new FileInfo(file).Length, HashFile(file)));
            }
        }
        else if (File.Exists(path))
        {
            entries.Add((Path.GetFileName(path), new FileInfo(path).Length, HashFile(path)));
        }
        else
        {
            return "";
        }

        if (entries.Count == 0) return "";
        entries.Sort((a, b) => string.CompareOrdinal(a.Rel, b.Rel));

        var manifest = new StringBuilder();
        foreach (var e in entries)
            manifest.Append(e.Rel).Append('\n').Append(e.Size).Append('\n').Append(e.Hash).Append('\n');

        return Hex(SHA256.HashData(Encoding.UTF8.GetBytes(manifest.ToString())));
    }

    private static string HashFile(string file)
    {
        using var fs = File.OpenRead(file);
        return Hex(SHA256.HashData(fs));
    }

    private static string Hex(byte[] bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    /// <summary>Zip a save folder (or single file) to a temp .zip; returns its path.</summary>
    public static string CreateZip(string path)
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"gamesync-{Guid.NewGuid():N}.zip");
        if (Directory.Exists(path))
        {
            ZipFile.CreateFromDirectory(path, tmp, CompressionLevel.Optimal, includeBaseDirectory: false);
        }
        else if (File.Exists(path))
        {
            using var zip = ZipFile.Open(tmp, ZipArchiveMode.Create);
            zip.CreateEntryFromFile(path, Path.GetFileName(path), CompressionLevel.Optimal);
        }
        else
        {
            throw new FileNotFoundException("Save path does not exist", path);
        }
        WriteMetadata(tmp, path);
        return tmp;
    }

    /// <summary>
    /// Record file/dir attributes and full-precision timestamps into a sidecar
    /// entry in the zip. The zip format only carries a 2-second last-write time
    /// and no attributes/creation time, which desyncs games that validate their
    /// save folder against a manifest (e.g. the <c>containers.index</c> of an
    /// Xbox/Microsoft-Store <c>wgs</c> save), making them report "unknown save".
    /// </summary>
    private static void WriteMetadata(string zipPath, string sourcePath)
    {
        var metas = new List<FileMeta>();
        if (Directory.Exists(sourcePath))
        {
            foreach (var dir in Directory.EnumerateDirectories(sourcePath, "*", SearchOption.AllDirectories))
            {
                var di = new DirectoryInfo(dir);
                metas.Add(new FileMeta(Rel(sourcePath, dir), true,
                    (int)di.Attributes, di.CreationTimeUtc.Ticks, di.LastWriteTimeUtc.Ticks));
            }
            foreach (var file in Directory.EnumerateFiles(sourcePath, "*", SearchOption.AllDirectories))
            {
                var fi = new FileInfo(file);
                metas.Add(new FileMeta(Rel(sourcePath, file), false,
                    (int)fi.Attributes, fi.CreationTimeUtc.Ticks, fi.LastWriteTimeUtc.Ticks));
            }
        }
        else if (File.Exists(sourcePath))
        {
            var fi = new FileInfo(sourcePath);
            metas.Add(new FileMeta(Path.GetFileName(sourcePath), false,
                (int)fi.Attributes, fi.CreationTimeUtc.Ticks, fi.LastWriteTimeUtc.Ticks));
        }

        using var zip = ZipFile.Open(zipPath, ZipArchiveMode.Update);
        var entry = zip.CreateEntry(MetaEntry, CompressionLevel.Optimal);
        using var s = entry.Open();
        using var w = new StreamWriter(s, new UTF8Encoding(false));
        w.Write(JsonSerializer.Serialize(metas));
    }

    private static string Rel(string root, string full) =>
        Path.GetRelativePath(root, full).Replace('\\', '/');

    /// <summary>
    /// Replace the save folder's *contents* with the zip, in place. The target
    /// directory itself is never moved or recreated, so an attached
    /// FileSystemWatcher keeps working after a sync. Current contents are moved
    /// aside first and restored if anything fails, so a crash mid-apply never
    /// leaves a half-written save.
    /// </summary>
    public static void ApplyZip(string zipPath, string targetPath)
    {
        var staging = Path.Combine(Path.GetTempPath(), $"gamesync-extract-{Guid.NewGuid():N}");
        var backup = Path.Combine(Path.GetTempPath(), $"gamesync-bak-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        Directory.CreateDirectory(backup);
        Directory.CreateDirectory(targetPath);
        try
        {
            ZipFile.ExtractToDirectory(zipPath, staging, overwriteFiles: true);

            // Pull the metadata sidecar out of the way so it never reaches the
            // game's save folder (which would also break the content hash).
            var metas = ReadMetadata(zipPath);
            var stagedMeta = Path.Combine(staging, MetaEntry);
            if (File.Exists(stagedMeta)) File.Delete(stagedMeta);

            MoveContents(targetPath, backup); // clear target but keep its inode
            try
            {
                // COPY (don't move) the staged files into the save folder. The
                // agent runs as LocalSystem and stages under C:\Windows\Temp; a
                // *move* would carry those SYSTEM-only ACLs into the user's save
                // folder, so the game (running as the user) can't read the files
                // and reports "unknown save". Copying *creates* the files in the
                // target, so they inherit the folder's user ACL — exactly what a
                // manual Explorer paste does, which is the one thing that works.
                CopyContents(staging, targetPath);
            }
            catch
            {
                ClearContents(targetPath);
                MoveContents(backup, targetPath); // restore on failure
                throw;
            }

            // Re-apply attributes + full-precision timestamps the zip dropped, so
            // the applied save is byte- and metadata-identical to a manual copy.
            ApplyMetadata(targetPath, metas);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
        }
    }

    private static void MoveContents(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var dir in Directory.GetDirectories(src))
            Directory.Move(dir, Path.Combine(dst, Path.GetFileName(dir)));
        foreach (var file in Directory.GetFiles(src))
            File.Move(file, Path.Combine(dst, Path.GetFileName(file)), overwrite: true);
    }

    /// <summary>
    /// Recursively copy a folder's contents into <paramref name="dst"/>, creating
    /// each file/dir fresh so it inherits the destination's ACL (rather than
    /// carrying the source's permissions, as a move would). Used when applying a
    /// save so synced files get the user's permissions, like a manual paste.
    /// </summary>
    private static void CopyContents(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var dir in Directory.GetDirectories(src))
            CopyContents(dir, Path.Combine(dst, Path.GetFileName(dir)));
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), overwrite: true);
    }

    private static List<FileMeta> ReadMetadata(string zipPath)
    {
        using var zip = ZipFile.OpenRead(zipPath);
        var entry = zip.GetEntry(MetaEntry);
        if (entry == null) return new List<FileMeta>(); // old save, pre-metadata
        using var s = entry.Open();
        using var r = new StreamReader(s);
        return JsonSerializer.Deserialize<List<FileMeta>>(r.ReadToEnd()) ?? new List<FileMeta>();
    }

    /// <summary>
    /// Restore recorded timestamps then attributes onto the applied save. Times
    /// are set before attributes so a restored ReadOnly bit can't block the time
    /// write; directories are done after files so moving files in doesn't bump a
    /// directory's mod-time back. Best-effort per entry — a single failure (a
    /// missing file, a locked handle) must not abort the whole apply.
    /// </summary>
    private static void ApplyMetadata(string targetPath, List<FileMeta> metas)
    {
        foreach (var m in metas)
        {
            if (m.IsDir) continue;
            var full = Path.Combine(targetPath, m.Rel.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) continue;
            try
            {
                File.SetCreationTimeUtc(full, new DateTime(m.CreationUtc, DateTimeKind.Utc));
                File.SetLastWriteTimeUtc(full, new DateTime(m.LastWriteUtc, DateTimeKind.Utc));
                File.SetAttributes(full, (FileAttributes)m.Attributes);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
        }
        foreach (var m in metas)
        {
            if (!m.IsDir) continue;
            var full = Path.Combine(targetPath, m.Rel.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(full)) continue;
            try
            {
                Directory.SetCreationTimeUtc(full, new DateTime(m.CreationUtc, DateTimeKind.Utc));
                Directory.SetLastWriteTimeUtc(full, new DateTime(m.LastWriteUtc, DateTimeKind.Utc));
                new DirectoryInfo(full).Attributes = (FileAttributes)m.Attributes;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
        }
    }

    private static void ClearContents(string dir)
    {
        foreach (var d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
        foreach (var f in Directory.GetFiles(dir)) File.Delete(f);
    }

    /// <summary>True if every file under path can be opened for reading (not locked).</summary>
    public static bool IsReadable(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
                    using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read)) { }
                return true;
            }
            if (File.Exists(path))
            {
                using (File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) { }
                return true;
            }
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        return false;
    }
}
