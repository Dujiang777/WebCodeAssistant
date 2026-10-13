package com.webcode.assistant.api;

import com.webcode.assistant.room.RoomNote;
import com.webcode.assistant.room.RoomService;
import com.webcode.assistant.room.RoomHub;
import com.webcode.assistant.security.CurrentUser;
import com.webcode.assistant.security.UserRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

/**
 * 讨论室：登录用户之间的公屏和私聊，用来商量代码怎么改。
 * 不碰工作区磁盘，也不走模型。
 */
@RestController
@RequestMapping("/api/room")
public class RoomController {

    private final RoomService roomService;
    private final RoomHub roomHub;
    private final CurrentUser currentUser;

    public RoomController(RoomService roomService, RoomHub roomHub, CurrentUser currentUser) {
        this.roomService = roomService;
        this.roomHub = roomHub;
        this.currentUser = currentUser;
    }

    @GetMapping("/people")
    public List<UserRepository.UserBrief> people() {
        return roomService.people(currentUser.requireId());
    }

    @GetMapping("/messages")
    public List<RoomNote> messages(@RequestParam(value = "peerId", required = false) Long peerId) {
        return roomService.history(currentUser.requireId(), peerId);
    }

    @PostMapping("/messages")
    public RoomNote send(@Valid @RequestBody SendRequest request) {
        var me = currentUser.require();
        return roomService.send(me.userId(), me.username(), request.peerId(), request.body(), request.filePath());
    }

    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(value = "afterId", required = false) Long afterId) {
        return roomHub.subscribe(currentUser.requireId(), afterId);
    }

    public record SendRequest(
            Long peerId,
            @NotBlank @Size(max = 1000) String body,
            @Size(max = 240) String filePath
    ) {
    }
}
