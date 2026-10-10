// Makes the bindings to native UI Automation that the desktop helper is
// compiled against, at build time, from the type library that Windows itself
// keeps inside UIAutomationCore.dll: what tlbimp.exe from the Windows SDK would
// make, without the SDK. The helper is compiled with /link against the result,
// which copies the few interfaces it uses into the helper itself, so the file
// made here is needed only while building and never ships.
//
// Usage: UiaInterop.exe <output dll path>
// Run by scripts/build-desktop-helper.js.

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

static class UiaInterop
{
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int kind, out ITypeLib library);

    /// <summary>Reports problems; the UI Automation library refers to no other, so there is nothing to resolve.</summary>
    class Sink : ITypeLibImporterNotifySink
    {
        public void ReportEvent(ImporterEventKind kind, int code, string text)
        {
            if (kind == ImporterEventKind.ERROR_REFTOINVALIDTYPELIB) Console.Error.WriteLine("UiaInterop: " + text);
        }

        public Assembly ResolveRef(object library)
        {
            return null;
        }
    }

    static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: UiaInterop.exe <output dll path>");
            return 2;
        }
        string output = Path.GetFullPath(args[0]);
        ITypeLib library;
        // REGKIND_NONE: read the library, register nothing.
        LoadTypeLibEx(Path.Combine(Environment.SystemDirectory, "UIAutomationCore.dll"), 2, out library);
        AssemblyBuilder built = new TypeLibConverter().ConvertTypeLibToAssembly(
            library, output, TypeLibImporterFlags.None, new Sink(), null, null, "UIAutomationClient", null);
        built.Save(Path.GetFileName(output));
        return 0;
    }
}
