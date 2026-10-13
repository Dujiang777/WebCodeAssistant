package com.webcode.assistant.api;

import com.webcode.assistant.room.RoomNote;
import com.webcode.assistant.room.RoomNotice;
import com.webcode.assistant.room.RoomService;
import com.webcode.assistant.security.CurrentUser;
import jakarta.servlet.http.HttpServletResponse;
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
    private final CurrentUser currentUser;

    public RoomController(RoomService roomService, CurrentUser currentUser) {
        this.roomService = roomService;
        this.currentUser = currentUser;
    }

    @GetMapping("/people")
    public List<RoomService.PersonPresence> people() {
        return roomService.people(currentUser.requireId());
    }

    @GetMapping("/messages")
    public List<RoomNote> messages(@RequestParam(value = "peerId", required = false) Long peerId) {
        return roomService.history(currentUser.requireId(), peerId);
    }

    @GetMapping("/notices")
    public List<RoomNotice> notices() {
        return roomService.notices(currentUser.requireId());
    }

    @PostMapping("/notices/read")
    public Marked read(@Valid @RequestBody ReadRequest request) {
        int marked = roomService.markRead(currentUser.requireId(), request.kind(), request.peerId());
        return new Marked(marked);
    }

    @PostMapping("/messages")
    public RoomNote send(@Valid @RequestBody SendRequest request) {
        return roomService.send(currentUser.requireId(), request.peerId(), request.body(), request.filePath());
    }

    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(value = "afterId", required = false) Long afterId,
                             HttpServletResponse response) {
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        var me = currentUser.require();
        return roomService.open(me.userId(), me.username(), afterId);
    }

    public record SendRequest(
            Long peerId,
            @NotBlank @Size(max = 1000) String body,
            @Size(max = 240) String filePath
    ) {
    }

    public record ReadRequest(
            @NotBlank @Size(max = 16) String kind,
            Long peerId
    ) {
    }

    public record Marked(int marked) {
    }
}
