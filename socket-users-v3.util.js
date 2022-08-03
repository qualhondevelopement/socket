
var _ = require("underscore");
const {
  getAdminByEmail
} = require("../controllers/admin/auth.controller");
const {
  changeStatus,
  getAllAvailableAdmins,
  getAdminDetailsWithId,
} = require("../controllers/common/common.controller");
const {
  getSettingFunction,
} = require("../controllers/setting/setting.controller");
const {
  updateConversation,
  messageConversation,
  transferConversation,
  endActiveChat,
  conversationWaitingList,
  removeFromWaitingList,
  getSpecificConversationDetail,
  markAllMessagesAsUnread,
  checkIfUserInWaitingList,
  getQueueList,
} = require("../controllers/chat/chat.controller");

var admins = {};

const asyncEvery = async (arr, predicate) => {
  for (let e of arr) {
    if (!(await predicate(e))) return false;
  }
  return true;
};

// ----------------- admins cache functionality started ---------------- //
const ifAnyAdminOnline = async () => {
  return Object.keys(admins).length > 0;
};

const ifSpecificAdminWithUidOnline = async (adminId) => {
  return admins[adminId] ? true : false;
};

const addNewAdmin = async (adminId) => {
  const isOnline = await ifSpecificAdminWithUidOnline(adminId);
  if (!isOnline) {
    const admin = await getAdminDetailsWithId(adminId);
    admins[adminId] = admin;
  }

  return admins[adminId];
};

const deleteAdmin = async (adminId) => {
  const isOnline = await ifSpecificAdminWithUidOnline(adminId);
  if (isOnline) {
    delete admins[adminId];
  }
};

const sortAdmins = async () => {
  admins = Object.entries(admins)
    .sort(([, a], [, b]) => a.roomJoined.length - b.roomJoined.length)
    .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
};

const getAdminsAvailableForChatTransfer = async (admin) => {
  const onlineAdmins = Object.assign({}, admins);
  delete onlineAdmins[admin.uid];

  const settings = await getSettingFunction();

  if (Object.keys(onlineAdmins).length > 0) {
    const onlineAdminsArr = Object.keys(onlineAdmins)
      .filter((key) => {
        return onlineAdmins[key].roomJoined.length < settings.user_count;
      })
      .map((key) => {
        return {
          ...onlineAdmins[key],
          roomJoined: onlineAdmins[key].roomJoined,
        };
      });
    return onlineAdminsArr;
  } else {
    return [];
  }
};

(async function () {
  const adminsOnline = await getAllAvailableAdmins();
  adminsOnline.forEach((admin) => {
    admins[admin.uid] = admin;
  });
  sortAdmins();
})();

const allAdminsSockets = async (io) => {
  const adminSockets = [];
  const admins = io.sockets.adapter.rooms.get("allAdmins");
  const clients = io.sockets.sockets;

  if (admins) {
    admins.forEach((admin) => {
      adminSockets.push(clients.get(admin));
    });
  }

  return adminSockets;
};

const specificAdminSockets = async (io, adminUid) => {
  const adminSockets = [];
  const admins = io.sockets.adapter.rooms.get("allAdmins");
  const clients = io.sockets.sockets;

  if (admins) {
    admins.forEach((admin) => {
      const adminSocket = clients.get(admin);
      if (adminSocket.adminDetails.uid === adminUid) {
        adminSockets.push(adminSocket);
      }
    });
  }

  return adminSockets;
};

const specificUserSocket = async (io, roomId) => {
  const clients = io.sockets.sockets;

  let userSockets = [];

  if (clients) {
    clients.forEach((client) => {
      if (!client.isAdmin && client.room_id === roomId) {
        userSockets.push(client);
      }
    });
  }

  return userSockets;
};

const getAllAdminsExceptCSR = async () => {
  const onlineAdmins = Object.assign({}, admins);
  if (Object.keys(onlineAdmins).length > 0) {
    const onlineAdminsArr = Object.keys(onlineAdmins)
      // .filter((key) => onlineAdmins[key].adminDetails.role != 3)
      .filter((key) => key)
      .map((key) => onlineAdmins[key]);
    return onlineAdminsArr;
  } else {
    return [];
  }
};

const emitNewActiveChatToAllAdmins = async (roomId, io) => {
  const onlineAdmins = await getAllAdminsExceptCSR();
  onlineAdmins.forEach(async (admin) => {
    const conversation = await getSpecificConversationDetail(roomId, admin.uid);
    io.to(admin.uid).emit("active chats", {
      ...conversation,
      new: true,
    });
    if (admin.uid !== conversation.who) {
      io.to(admin.uid).emit("new notification", {
        title: `New active chat`,
        message: `${conversation.adminName} started new chat with ${conversation.name}`,
        notificationType: 2, //1 | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
        roomId: `${roomId}`,
        link: `admin/chat/active-chat/${roomId}`,
      });
    }
  });
};

const emitUpdateActiveChatToAllAdmins = async (roomId, io) => {
  const onlineAdmins = await getAllAdminsExceptCSR();
  onlineAdmins.forEach(async (admin) => {
    const conversation = await getSpecificConversationDetail(roomId, admin.uid);
    io.to(admin.uid).emit("update active chat", conversation);
  });
};
// ----------------- admins cache functionality ended ---------------- //

//----------------- main socket functions started --------------------//
const newUserLogin = async (data, socket, io) => {
  socket.isAdmin = false;
  const { conversation_id, room_id, ...rest } = data;
  socket.conversation_id = conversation_id;
  socket.room_id = room_id;
  socket.userDetails = rest;

  socket.join(socket.room_id);

  const chat = await getSpecificConversationDetail(data.room_id, null);

  if (!chat.who) {
    const waitingList = await checkIfUserInWaitingList(socket.userDetails.uid);
    const anyAdminOnline = await ifAnyAdminOnline();
    const settings = await getSettingFunction();
    const noAdminAvailableForChat = await asyncEvery(
      Object.keys(admins),
      async (i) => {
        const adminData = await getAdminByEmail(admins[i].email);
        return (
          admins[i].roomJoined.length > settings.user_count - 1 ||
          !adminData.auto_chat_assign ||
          admins[i].activeStatus != 1
        );
      }
    );
    if (
      (!anyAdminOnline ||
        noAdminAvailableForChat ||
        !settings.queue_auto_assign) &&
      waitingList.count === 0
    ) {
      socket.emit("log message", {
        message:
          "Thank you for reaching us." +
          " Please leave your message here and we will get back to you shortly.",
        adminName: "N/A",
        adminImage: null,
      });

      await messageConversation({
        conversation_id: socket.conversation_id,
        who: null,
        whom: socket.userDetails.uid,
        isAdmin: true,
        message:
          "Thank you for reaching us. Please leave your message here and we will get back to you shortly.",
        log_message: 1,
        log_message_type: 1,
      });

      await conversationWaitingList({
        uid: socket.userDetails.uid,
        room_id: socket.room_id,
        wait_count: 1,
      });

      socket.broadcast.to("allAdmins").emit("queue list", {
        ...chat,
        new: true,
      });

      socket.broadcast.to("allAdmins").emit("new notification", {
        title: `New user in queue`,
        message: `${socket.userDetails.name} is waiting in queue`,
        notificationType: 4, //1 | 2 | 3 | 4 | 5 | 6; //message | activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
        roomId: `${socket.room_id}`,
        link: `admin/chat/queue-list/${socket.room_id}`,
        playAudio: true,
      });
    } else if (
      anyAdminOnline &&
      !noAdminAvailableForChat &&
      settings.queue_auto_assign
    ) {
      Object.keys(admins).every(async (key) => {
        const admin = admins[key];
        const adminData = await getAdminByEmail(admin.email);
        if (
          admin.roomJoined.length < settings.user_count &&
          adminData.auto_chat_assign &&
          adminData.active_status === 1
        ) {
          socket.emit("log message", {
            message: "Hello " + admin.name + ", How can I help you?",
            adminName: adminData.name,
            adminImage: adminData.image,
          });

          admin.roomJoined.push(socket.room_id);

          await updateConversation({ admin_uid: key }, socket.conversation_id);
          admins[key] = admin;
          await emitNewActiveChatToAllAdmins(socket.room_id, io);

          await messageConversation({
            conversation_id: socket.conversation_id,
            who: key,
            whom: socket.userDetails.uid,
            isAdmin: true,
            log_message_type: 1,
            message: `Hello ${socket.userDetails.name}, How can I help you?`,
            log_message: 1,
          });

          return false;
        }

        return true;
      });
    }
  }

  await sortAdmins();
  await fetchOnlineAdminsList(io);
};

const newAdminLogin = async (data, socket, io) => {
  socket.join("allAdmins");
  socket.isAdmin = true;
  socket.adminDetails = data;
  if (data.isNewUser) {
    socket.emit("admin_room_id", "data.room_id");
    socket.adminDetails.activeStatus = 1;
  }
  await changeStatus(socket.adminDetails.uid, socket.adminDetails.activeStatus);
  socket.join(socket.adminDetails.uid);

  const adminData = await addNewAdmin(socket.adminDetails.uid);

  if (adminData.auto_chat_assign && adminData.activeStatus == 1) {
    const settings = await getSettingFunction();
    if (
      settings.queue_auto_assign &&
      adminData.roomJoined.length < settings.user_count
    ) {
      const queueList = await getQueueList();
      queueList.forEach(async (chat) => {
        if (adminData.roomJoined.length < settings.user_count) {
          await updateConversation(
            { admin_uid: socket.adminDetails.uid },
            chat.conversation_id
          );
          io.to(chat.room_id).emit("chat message", {
            room_id: chat.room_id,
            message: `${socket.adminDetails.name} has joined you, please let me know how can i help you?`,
            who: socket.adminDetails.uid,
            whom: chat.uid,
            logMessage: true,
            log_message_type: 1,
            isAdmin: true,
            createdAt: new Date(),
            adminName: socket.adminDetails.name,
            adminImage: socket.adminDetails.image,
          });
          await emitNewActiveChatToAllAdmins(chat.room_id, io);

          await messageConversation({
            conversation_id: chat.conversation_id,
            who: socket.adminDetails.uid,
            whom: chat.uid,
            isAdmin: true,
            message: `${socket.adminDetails.name} has joined you, please let me know how can i help you?`,
            log_message: 1,
            log_message_type: 1,
          });

          adminData.roomJoined.push(chat.room_id);
          admins[adminData.uid] = adminData;
          await removeFromWaitingList({ uid: chat.uid });
        }
      });
    }
  }

  await sortAdmins();
  await fetchOnlineAdminsList(io, {
    adminuID: socket.adminDetails.uid,
    status: socket.adminDetails.activeStatus,
    statusClass: "online",
  });

  return socket.adminDetails.activeStatus;
};

const sendNewMessage = async (data, socket, io) => {
  io.to(data.room_id).emit("chat message", {
    ...data,
    createdAt: new Date(),
    logMessage: false,
  });
  io.to("allAdmins").emit("chat message", {
    ...data,
    createdAt: new Date(),
    logMessage: false,
  });

  socket.broadcast.to(data.room_id).emit("new notification", {
    title: `New message recieved`,
    message: `${data.message}`,
    notificationType: 1, // | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
    roomId: `${data.room_id}`,
    link: data.isAdmin ? "user/chat" : `admin/chat/active-chat/${data.room_id}`,
    playAudio: true,
  });
  socket.broadcast.to("allAdmins").emit("new notification", {
    title: `New message recieved`,
    message: `${data.message}`,
    notificationType: 1, // | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
    roomId: `${data.room_id}`,
    link: data.isAdmin ? "user/chat" : `admin/chat/active-chat/${data.room_id}`,
    playAudio: true,
  });

  await messageConversation(data);
};

const transferRequest = async (data, socket, io) => {
  const adminSocket = await admins[data.transferTo];
  if (!adminSocket) {
    return {
      status: false,
      message: "Admin logout, you can't transfer this request",
    };
  } else if (adminSocket && adminSocket.activeStatus != 1) {
    return {
      status: false,
      message: "Admin is not online, you can't transfer this request",
    };
  } else {
    const chat = await getSpecificConversationDetail(
      data.room_id,
      data.transferTo
    );
    io.to(data.transferTo).emit("new notification", {
      title: `Chat transferred`,
      message: `${chat.adminName} transferred ${chat.name}'s chat to you`,
      notificationType: 2, //1 | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
      roomId: `${data.room_id}`,
      link: `admin/chat/active-chat/${data.room_id}`,
    });
    await messageConversation({
      conversation_id: chat.conversation_id,
      who: data.transferFrom,
      whom: data.transferTo,
      isAdmin: false,
      message: `${chat.adminName} transferred ${chat.name}'s chat to ${adminSocket.name}`,
      log_message: 1,
      log_message_type: 4,
    });
    io.to(data.room_id).emit("chat message", {
      room_id: data.room_id,
      message: `${chat.adminName} transferred ${chat.name}'s chat to ${adminSocket.name}`,
      who: data.transferFrom,
      whom: data.transferTo,
      logMessage: true,
      log_message_type: 4,
      isAdmin: false,
      createdAt: new Date(),
      adminName: adminSocket.name,
      adminImage: adminSocket.image,
    });
    const roomIndex = admins[data.transferFrom].roomJoined.indexOf(
      data.room_id
    );
    if (roomIndex > -1) {
      admins[data.transferFrom].roomJoined.splice(roomIndex, 1);
    }

    admins[data.transferTo].roomJoined.push(data.room_id);

    data["conversation_id"] = chat.conversation_id;

    await transferConversation(data);
    await updateConversation(
      { admin_uid: data.transferTo },
      chat.conversation_id
    );
    await emitUpdateActiveChatToAllAdmins(data.room_id, io);

    await sortAdmins();
    await fetchOnlineAdminsList(io);
    return { status: true };
  }
};

const takeOverChat = async (data, socket, io) => {
  const chat = await getSpecificConversationDetail(data.room_id, null);
  socket.broadcast.to(data.transferFrom).emit("new notification", {
    title: `Chat transferred`,
    message: `${socket.adminDetails.name} take over ${chat.name}'s chat`,
    notificationType: 2, //1 | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
    roomId: `${data.room_id}`,
    link: `admin/chat/all-active-chat/${data.room_id}`,
  });

  await messageConversation({
    conversation_id: chat.conversation_id,
    who: data.transferTo,
    whom: data.transferFrom,
    isAdmin: false,
    message: `${socket.adminDetails.name} take over ${chat.name}'s chat`,
    log_message: 1,
    log_message_type: 4,
  });

  socket.broadcast.to(data.room_id).emit("chat message", {
    room_id: data.room_id,
    message: `${socket.adminDetails.name} take over ${chat.name}'s chat`,
    who: data.transferTo,
    whom: data.transferFrom,
    logMessage: true,
    log_message_type: 4,
    isAdmin: false,
    createdAt: new Date(),
    adminName: socket.adminDetails.name,
    adminImage: socket.adminDetails.image,
  });

  io.to("allAdmins").emit("chat message", {
    room_id: data.room_id,
    message: `${socket.adminDetails.name} take over ${chat.name}'s chat`,
    who: data.transferTo,
    whom: data.transferFrom,
    logMessage: true,
    log_message_type: 4,
    isAdmin: false,
    createdAt: new Date(),
    adminName: socket.adminDetails.name,
    adminImage: socket.adminDetails.image,
  });
  const roomIndex = admins[data.transferFrom].roomJoined.indexOf(data.room_id);
  if (roomIndex > -1) {
    admins[data.transferFrom].roomJoined.splice(roomIndex, 1);
  }

  admins[socket.adminDetails.uid].roomJoined.push(data.room_id);

  data["conversation_id"] = chat.conversation_id;

  await transferConversation(data);
  await emitUpdateActiveChatToAllAdmins(data.room_id, io);

  await updateConversation(
    { admin_uid: socket.adminDetails.uid },
    chat.conversation_id
  );

  await sortAdmins();
  await fetchOnlineAdminsList(io);
  return { status: true };
};

const endChat = async (data, socket, io, inactivity = false) => {
  const chat = await getSpecificConversationDetail(data.room_id, null);
  io.to("allAdmins").emit("remove active chat", data.room_id);
  if (data.isAdmin) {
    let roomIndex = -1;
    if (admins[chat.who]) {
      roomIndex = admins[chat.who].roomJoined.indexOf(data.room_id);
    }
    if (roomIndex > -1) {
      admins[chat.who].roomJoined.splice(roomIndex, 1);
    }
    io.to(data.room_id).emit("admin ended chat", data.room_id);
    await messageConversation({
      conversation_id: chat.conversation_id,
      who: chat.who,
      whom: chat.uid,
      isAdmin: true,
      message: "Admin ended chat",
      log_message: 1,
      log_message_type: 4,
    });
    io.to(data.room_id).emit("chat message", {
      room_id: data.room_id,
      message: "Admin ended chat",
      who: chat.who,
      whom: chat.uid,
      logMessage: true,
      log_message_type: 4,
      isAdmin: true,
      createdAt: new Date(),
    });
    io.to("allAdmins").emit("chat message", {
      room_id: data.room_id,
      message: "Admin ended chat",
      who: chat.who,
      whom: chat.uid,
      logMessage: true,
      log_message_type: 4,
      isAdmin: true,
      createdAt: new Date(),
    });
    io.to("allAdmins").emit("new notification", {
      title: `Chat ended`,
      message: `${chat.adminName} ended chat with user ${chat.name}`,
      notificationType: 2, //1 | 2 | 3 | 4 | 5 | 6; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat;
      roomId: `${data.room_id}`,
      playAudio: true,
    });
  } else {
    if (chat.who) {
      let roomIndex = -1;
      if (admins[chat.who]) {
        roomIndex = admins[chat.who].roomJoined.indexOf(data.room_id);
      }
      if (roomIndex > -1) {
        admins[chat.who].roomJoined.splice(roomIndex, 1);
      }
      io.to(data.room_id).emit("chat message", {
        room_id: data.room_id,
        message: "User has left the chat",
        who: chat.uid,
        whom: chat.who,
        logMessage: true,
        log_message_type: 3,
        isAdmin: false,
        createdAt: new Date(),
      });
      io.to("allAdmins").emit("chat message", {
        room_id: data.room_id,
        message: "User has left the chat",
        who: chat.uid,
        whom: chat.who,
        logMessage: true,
        log_message_type: 3,
        isAdmin: false,
        createdAt: new Date(),
      });
    } else {
      await removeFromWaitingList({ uid: chat.uid });
      io.to("allAdmins").emit("remove queue user", data.room_id);
    }

    if (inactivity) {
      io.to(data.room_id).emit("admin ended chat", data.room_id);
    }

    await messageConversation({
      conversation_id: chat.conversation_id,
      who: chat.uid,
      whom: chat.who,
      isAdmin: false,
      message: "User has left the chat",
      log_message: 1,
      log_message_type: 3,
    });
    const userSockets = await specificUserSocket(io, data.room_id);

    if (userSockets) {
      userSockets.forEach((userSocket) => {
        userSocket.leave(data.room_id);
      });
    }
  }
  await sortAdmins();
  await fetchOnlineAdminsList(io);
  await endActiveChat(data);
};

const cronEndChat = async (data, io) => {
  io.to("allAdmins").emit("remove active chat", data.room_id);

  const roomIndex = admins[data.auid].roomJoined.indexOf(data.room_id);
  if (roomIndex > -1) {
    admins[data.auid].roomJoined.splice(roomIndex, 1);
  }

  io.to(data.auid).emit("new notification", {
    title: `Chat ended`,
    message: `Chat has been ended due to inactivity`,
    notificationType: 7, //1 | 2 | 3 | 4 | 5 | 6 | 7; //message \ activeChat | activeChatRemoved | queueMember | queueMemberRemoved | transferChat | chatEnded;
    roomId: `${data.room_id}`,
    link: `admin/chat/active-chat`,
    playAudio: true,
  });

  io.to(data.room_id).emit("chat message", {
    room_id: data.room_id,
    message: "Chat has been ended due to inactivity",
    who: data.auid,
    whom: data.uid,
    logMessage: true,
    log_message_type: 4,
    isAdmin: true,
    createdAt: new Date(),
  });
  io.to("allAdmins").emit("chat message", {
    room_id: data.room_id,
    message: "Chat has been ended due to inactivity",
    who: data.auid,
    whom: data.uid,
    logMessage: true,
    log_message_type: 4,
    isAdmin: true,
    createdAt: new Date(),
  });

  await messageConversation({
    conversation_id: data.conversation_id,
    who: data.auid,
    whom: data.uid,
    isAdmin: true,
    message: "Chat has been ended due to inactivity",
    log_message: 1,
    log_message_type: 4,
  });

  io.to(data.room_id).emit("no activity end chat", data);

  _.each(admins, async (adminSocket) => {
    const onlineAdmins = await getAdminsAvailableForChatTransfer(adminSocket);
    io.to(adminSocket.uid).emit(
      "online admins list",
      JSON.stringify(onlineAdmins)
    );
  });

  await sortAdmins();
  await endActiveChat(data);
};

const fetchOnlineAdminsList = async (io, data = null) => {
  _.each(admins, async (admin) => {
    const onlineAdmins = await getAdminsAvailableForChatTransfer(admin);
    io.to(admin.uid).emit("online admins list", JSON.stringify(onlineAdmins));

    if (data && admin.uid !== data.adminuID) {
      switch (+data.status) {
        case 1:
          data.status = "Online";
          data.statusClass = "online";
          break;
        case 2:
          data.status = "Offline";
          data.statusClass = "offline";
          break;
        case 3:
          data.status = "Busy";
          data.statusClass = "away";
          break;
        case 4:
          data.status = "Do not disturb";
          data.statusClass = "do-not-disturb";
          break;
        default:
          data.status = "Online";
          data.statusClass = "online";
      }
      io.to(admin.uid).emit("change admin status", data);
    }
  });
};

const adminLogout = async (socket, io) => {
  await changeStatus(socket.adminDetails.uid, 2);
  const admin = await getAdminDetailsWithId(socket.adminDetails.uid);
  admin.roomJoined.forEach(async (room, index) => {
    const chat = await getSpecificConversationDetail(room, null);
    socket.broadcast.to(room).emit("chat message", {
      room_id: room,
      message: "Admin disconnected",
      who: socket.adminDetails.uid,
      whom: chat.uid,
      logMessage: true,
      log_message_type: 4,
      isAdmin: true,
      createdAt: new Date(),
    });
    await messageConversation({
      conversation_id: chat.conversation_id,
      who: socket.adminDetails.uid,
      whom: chat.uid,
      isAdmin: true,
      message: `Admin disconnected`,
      log_message: 1,
      log_message_type: 4,
    });
  });
  await fetchOnlineAdminsList(io, {
    adminuID: socket.adminDetails.uid,
    status: 2,
    statusClass: "offline",
  });
  const adminSockets = await specificAdminSockets(io, socket.adminDetails.uid);
  adminSockets.forEach((adminSocket) => {
    adminSocket.leave("allAdmins");
    adminSocket.leave(adminSocket.adminDetails.uid);
  });

  await deleteAdmin(socket.adminDetails.uid);
};

const adminDisconnected = async (socket, io) => {
  setTimeout(async () => {
    const clients = io.sockets.adapter.rooms.get(socket.adminDetails.uid);

    if (!clients || !clients.size) {
      adminLogout(socket, io);
    }
  }, 5000);
};

const userDisconnected = async (socket, io) => {
  setTimeout(async () => {
    const clients = io.sockets.adapter.rooms.get(socket.room_id);
  }, 5000);
};

const adminJoinChat = async (data, socket, io) => {
  const chat = await getSpecificConversationDetail(
    data.room_id,
    socket.adminDetails.uid
  );

  if (chat.who) {
    return false;
  } else {
    io.to(data.room_id).emit("chat message", {
      room_id: chat.room_id,
      message: `${socket.adminDetails.name} has joined you, please let me know how can i help you?`,
      who: socket.adminDetails.uid,
      whom: chat.uid,
      logMessage: true,
      log_message_type: 1,
      isAdmin: true,
      createdAt: new Date(),
      adminName: socket.adminDetails.name,
      adminImage: socket.adminDetails.image,
    });
    await messageConversation({
      room_id: chat.room_id,
      conversation_id: chat.conversation_id,
      who: socket.adminDetails.uid,
      whom: chat.uid,
      isAdmin: true,
      message: `${socket.adminDetails.name} has joined you, please let me know how can i help you?`,
      log_message: 1,
      log_message_type: 1,
    });
    admins[socket.adminDetails.uid].roomJoined.push(data.room_id);

    io.to("allAdmins").emit("New Client", {
      ...chat,
      who: socket.adminDetails.uid,
      adminName: socket.adminDetails.name,
      adminImage: socket.adminDetails.image,
      new: true,
    });
    await updateConversation(
      { admin_uid: socket.adminDetails.uid },
      chat.conversation_id
    );
    await removeFromWaitingList({ uid: chat.uid });

    return true;
  }
};

const resetUnreadCount = async (conversationId, adminUid, io) => {
  await markAllMessagesAsUnread(conversationId, adminUid);
};

const typingStart = async (data, socket, io) => {
  if (data.isAdmin) {
    socket.to(data.room_id).emit("typing start", data);
  }
  socket.to("allAdmins").emit("typing start", data);
};

const typingStop = async (data, socket, io) => {
  if (data.isAdmin) {
    socket.to(data.room_id).emit("typing stop", data);
  }
  socket.to("allAdmins").emit("typing stop", data);
};

const logoutAllAdminSessions = async (uid, socket, io) => {
  if (admins[uid]) {
    const allRooms = io.of("/").adapter.rooms;
    const adminSockets = io.of("/").adapter.rooms.get(uid);

    io.to(uid).emit("logout admin");
    Object.keys(adminSockets).forEach((admin) => {
      Object.keys(allRooms).forEach((room) => {
        io.sockets.sockets[admin].leave(room);
      });
    });
  }
};

const adminChangeStatus = async (status, socket, io) => {
  const result = await changeStatus(socket.adminDetails.uid, status);
  admins[socket.adminDetails.uid].activeStatus = status;
  await fetchOnlineAdminsList(io, {
    adminuID: socket.adminDetails.uid,
    status: status,
    statusClass: "online",
  });
  return result ? true : false;
};

module.exports = {
  newUserLogin: newUserLogin,
  newAdminLogin: newAdminLogin,
  sendNewMessage: sendNewMessage,
  getAdminsAvailableForChatTransfer: getAdminsAvailableForChatTransfer,
  transferRequest: transferRequest,
  takeOverChat: takeOverChat,
  endChat: endChat,
  adminLogout: adminLogout,
  cronEndChat: cronEndChat,
  adminDisconnected: adminDisconnected,
  userDisconnected: userDisconnected,
  fetchOnlineAdminsList: fetchOnlineAdminsList,
  adminJoinChat: adminJoinChat,
  resetUnreadCount: resetUnreadCount,
  typingStart: typingStart,
  typingStop: typingStop,
  logoutAllAdminSessions: logoutAllAdminSessions,
  adminChangeStatus: adminChangeStatus,
};
