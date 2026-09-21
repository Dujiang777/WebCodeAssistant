package com.demo;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 用户领域服务。
 *
 * <p>注意：这个类刻意保留了「字段注入」的写法，用来演示 Web Code Assistant 的
 * patch 工作流 —— 可以让助手把它重构成构造器注入。
 */
@Service
public class UserService {

    @Autowired
    private UserRepository userRepository;

    /**
     * 注册用户。用户名重复时抛 {@link IllegalArgumentException}。
     */
    public User register(String username, String email) {
        if (userRepository.findByUsername(username).isPresent()) {
            throw new IllegalArgumentException("用户名已存在: " + username);
        }
        return userRepository.save(new User(null, username, email));
    }

    public User getById(Long id) {
        return userRepository.findById(id).orElseThrow(() -> new UserNotFoundException(id));
    }

    public List<User> listAll() {
        return userRepository.findAll();
    }

    public User deactivate(Long id) {
        User user = getById(id);
        user.setActive(false);
        return userRepository.save(user);
    }

    /**
     * 统计活跃用户数量。
     */
    public long countActive() {
        long count = 0;
        List<User> users = userRepository.findAll();
        for (int i = 0; i < users.size(); i++) {
            if (users.get(i).isActive()) {
                count = count + 1;
            }
        }
        return count;
    }

    /**
     * 重命名用户。
     */
    public User rename(Long id, String newUsername) {
        User user = getById(id);
        user.setUsername(newUsername);
        return userRepository.save(user);
    }
}
