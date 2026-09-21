package com.demo;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class UserServiceTest {

    private UserService userService;

    @BeforeEach
    void setUp() {
        // 目前是手工 new —— 字段注入让这里没法用构造器注入依赖，
        // 这也是待重构的点之一。
        userService = new UserService();
        setRepository(userService, new UserRepository());
    }

    @Test
    void register_shouldAssignId() {
        User user = userService.register("alice", "alice@example.com");
        assertEquals("alice", user.getUsername());
        assertTrue(user.isActive());
    }

    @Test
    void register_shouldRejectDuplicateUsername() {
        userService.register("alice", "alice@example.com");
        assertThrows(IllegalArgumentException.class,
                () -> userService.register("alice", "another@example.com"));
    }

    @Test
    void deactivate_shouldFlipActiveFlag() {
        User user = userService.register("bob", "bob@example.com");
        User deactivated = userService.deactivate(user.getId());
        assertFalse(deactivated.isActive());
        assertEquals(0, userService.countActive());
    }

    /** 反射注入，仅为绕过字段注入；重构后可以删掉。 */
    private static void setRepository(UserService service, UserRepository repository) {
        try {
            var field = UserService.class.getDeclaredField("userRepository");
            field.setAccessible(true);
            field.set(service, repository);
        } catch (ReflectiveOperationException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
