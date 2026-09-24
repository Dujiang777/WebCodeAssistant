package com.webcode.assistant.common;

import java.util.UUID;

/**
 * UUID 列的读写编解码。
 *
 * <p>数据库是 MySQL，没有原生的 {@code uuid} 类型（那是 PostgreSQL 的东西），
 * 因此 {@code patches.id} / {@code snapshots.id} / {@code snapshots.patch_id}
 * 都落在 {@code char(36)} 上。JDBC 层于是需要在两种表示之间来回转：
 *
 * <ul>
 *   <li>往 SQL 里绑参数 → {@link #toRaw(UUID)}，转成 36 字符的字符串；</li>
 *   <li>从 ResultSet 里取值 → {@link #fromRaw(String)}，还原成 {@link UUID}。</li>
 * </ul>
 *
 * <p>把这件事收在唯一一处，是因为它太容易漏：漏一处的表现不是编译错误，而是
 * 运行期丢进 {@code setObject(UUID)} 让驱动报类型不认，或者取出 {@code null}
 * 让 NPE 出现在离现场很远的地方。可空列（{@code snapshots.patch_id}）同样由
 * 这两个方法兜住 —— 空值原样穿透，不抛异常。
 */
public final class Uuids {

    private Uuids() {
    }

    /** UUID → char(36)；入参为 null 时返回 null（可空外键用）。 */
    public static String toRaw(UUID id) {
        return id == null ? null : id.toString();
    }

    /** char(36) → UUID；空白/缺省视为「没有值」，返回 null 而不是抛异常。 */
    public static UUID fromRaw(String raw) {
        return raw == null || raw.isBlank() ? null : UUID.fromString(raw.trim());
    }
}
