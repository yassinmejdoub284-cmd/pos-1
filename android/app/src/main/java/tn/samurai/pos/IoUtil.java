package tn.samurai.pos;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

final class IoUtil {
    private IoUtil() { }

    static void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            pipe(in, out);
            out.getFD().sync();
        }
    }

    static long pipe(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
            total += n;
        }
        out.flush();
        return total;
    }

    static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        pipe(in, out);
        return out.toString("UTF-8");
    }
}
