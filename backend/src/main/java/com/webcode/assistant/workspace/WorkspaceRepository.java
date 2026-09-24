package com.webcode.assistant.workspace;

import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/**
 * workspaces 表访问。
 *
 * <p>刻意提供 {@link #findOwned(long, long)} —— 工作区归属校验必须下推到 SQL，
 * 而不是「先查出来再在 Java 里比对 userId」，后者容易在新增调用点时漏掉。
 */
@Repository
public class WorkspaceRepository {

    private static final RowMapper<Workspace> MAPPER = (rs, rowNum) -> new Workspace(
            rs.getLong("id"),
            rs.getLong("user_id"),
            rs.getString("name"),
            rs.getString("root_path"),
            rs.getString("git_url"),
            rs.getLong("size_bytes"),
            rs.getTimestamp("created_at").toInstant());

    private static final String COLUMNS = "id, user_id, name, root_path, git_url, size_bytes, created_at";

    private final JdbcClient jdbc;

    public WorkspaceRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long insert(long userId, String name, String rootPath, String gitUrl, long sizeBytes) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("""
                        insert into workspaces (user_id, name, root_path, git_url, size_bytes)
                        values (:userId, :name, :rootPath, :gitUrl, :sizeBytes)
                        """)
                .param("userId", userId)
                .param("name", name)
                .param("rootPath", rootPath)
                .param("gitUrl", gitUrl)
                .param("sizeBytes", sizeBytes)
                .update(keys);
        Number id = keys.getKey();
        if (id == null) {
            throw new IllegalStateException("插入 workspaces 后未能取回自增主键");
        }
        return id.longValue();
    }

    public List<Workspace> findAllByUser(long userId) {
        return jdbc.sql("select " + COLUMNS + " from workspaces where user_id = :userId order by created_at desc")
                .param("userId", userId)
                .query(MAPPER)
                .list();
    }

    /** 归属校验与读取合成一次查询：查不到即视为「不存在或不属于你」。 */
    public Optional<Workspace> findOwned(long id, long userId) {
        return jdbc.sql("select " + COLUMNS + " from workspaces where id = :id and user_id = :userId")
                .param("id", id)
                .param("userId", userId)
                .query(MAPPER)
                .optional();
    }

    public void updateSize(long id, long sizeBytes) {
        jdbc.sql("update workspaces set size_bytes = :sizeBytes where id = :id")
                .param("sizeBytes", sizeBytes)
                .param("id", id)
                .update();
    }

    public boolean deleteOwned(long id, long userId) {
        return jdbc.sql("delete from workspaces where id = :id and user_id = :userId")
                .param("id", id)
                .param("userId", userId)
                .update() > 0;
    }
}
