package com.demo;

import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 内存版用户仓储。真实项目里这里会换成 JPA / MyBatis，
 * 演示项目保持零外部依赖，方便直接跑。
 */
@Repository
public class UserRepository {

    private final Map<Long, User> storage = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();

    public User save(User user) {
        if (user.getId() == null) {
            user.setId(sequence.incrementAndGet());
        }
        storage.put(user.getId(), user);
        return user;
    }

    public Optional<User> findById(Long id) {
        if (id == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(storage.get(id));
    }

    public Optional<User> findByUsername(String username) {
        if (username == null) {
            return Optional.empty();
        }
        return storage.values().stream()
                .filter(user -> username.equals(user.getUsername()))
                .findFirst();
    }

    public List<User> findAll() {
        return new ArrayList<>(storage.values());
    }

    public boolean deleteById(Long id) {
        return id != null && storage.remove(id) != null;
    }

    public int count() {
        return storage.size();
    }
}
