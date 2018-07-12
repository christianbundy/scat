const punycode = require('punycode')
const constants = require('./constants')
const compare = require('./compare')
const storage = require('./storage')

// #region initial state
let args = {}
let me
let meNames = new Set()
let client
let viewport = {}
let scrolling = {
  isScrolling: false,
  atTop: false,
  atBottom: true,
  index: 0
}
let input = ''
let messages = []
let filteredMessages = []
let viewableMessages = []
let privateRecipients = []
let lastPrivateRecipient = []
let filteredPrivateRecipients = []
let notifications = []
let currentMode = constants.MODE.PUBLIC
let privateMessageRoot = null
let systemMessage = null
let lastInput = ''
const authors = {}
// #endregion

// #region args
const getArgs = () => args
const setArgs = (val) => { args = val }
// #endregion

// #region input actions
const setInput = (value) => { input = value }
const getInputLinesLength = () => {
  // input length is `> `(2) + input.length
  // how many lines is that in my terminal?
  // Math.ceil(length / viewport.w)
  return Math.ceil((2 + input.length) / viewport.w)
}
// #endregion

// #region view actions
const setViewport = (w, h) => {
  viewport.w = w
  viewport.h = h
  viewport.showLines = h - 6
}
const getWidth = () => viewport.w
const viewPageUp = () => {
  if (scrolling.atTop || filteredMessages.length < viewport.showLines) {
    return
  }

  scrolling.isScrolling = true
  scrolling.index = (scrolling.index || filteredMessages.length) - viewableMessages.length - 1
  // are we at the top? (would one more scroll up show no messages)
  scrolling.atTop = (scrolling.index || filteredMessages.length) - viewableMessages.length - 1 < 1
}
const viewPageDown = () => {
  if (scrolling.atBottom) return

  if (scrolling.index >= 0) {
    scrolling.index += Math.max(viewableMessages.length, viewport.h - viewableMessages.length)
    scrolling.atTop = (scrolling.index || filteredMessages.length) - viewableMessages.length - 1 < 1
  }
}
const getScrolling = () => scrolling
const getViewableMessages = () => {
  // determine where to start in the messages array
  let start = filteredMessages.length - 1
  if (scrolling.isScrolling) {
    if (scrolling.index > filteredMessages.length - 1) {
      scrolling.atBottom = true
      scrolling.isScrolling = false
    } else {
      start = scrolling.index
      scrolling.atBottom = false
    }
  }

  const inputLines = getInputLinesLength()

  // set the viewable messages
  const viewable = []
  let viewableLines = inputLines

  for (let i = start; i >= 0; i--) {
    if (filteredMessages[i] && filteredMessages[i].lineLength) {
      const currentLineLength = filteredMessages[i].lineLength()
      const totalLines = viewableLines + currentLineLength + inputLines
      if (totalLines > viewport.showLines) {
        break
      }
      viewable.push(filteredMessages[i])
      viewableLines += currentLineLength
    }
  }

  viewableMessages = viewable.reverse().map(msg => `${msg.time}  ${msg.text()}`)
  return viewableMessages
}
// #endregion

// #region client actions
const getClient = () => client
const setClient = (c) => { client = c }
// #endregion

// #region me actions
const getMe = () => me
const setMe = (m) => { me = m }
const getMeNames = () => meNames
// #endregion

// #region author actions
const getAuthor = (author) => (authors[author] || {}).name || author
const getAuthors = () => authors
const getAuthorId = (name) => Object.keys(authors).find(author =>
  authors[author].name === name || authors[author].name === `@${name}`) || name
const setAuthor = (author, name, setter) => {
  if (typeof name !== 'string') {
    return
  }
  let cleanName = punycode.toASCII(name.normalize('NFC')) // :eyeroll: dangerous beans
  if (cleanName[0] !== '@') {
    cleanName = `@${cleanName}`
  }

  // if this is about me, add it to my list of self ids
  if (author === me) {
    meNames.add(cleanName)
  }
  const alreadySet = authors[author]
  // if we already have this author set
  // and it was already set by the author itself
  // and we are trying to set it ourselves
  // make that happen
  if (alreadySet && alreadySet.setter === author && author !== setter) {
    authors[author] = { name: cleanName, setter }
    return
  }
  // if any of that wasn't true, go ahead and set it
  authors[author] = { name: cleanName, setter }

  // we now potentially have a new author, so refresh the message view
  refreshMessageFilter()
}
// #endregion

// #region mode actions
const getMode = () => currentMode
const isPrivateMode = () => currentMode === constants.MODE.PRIVATE
const setPrivateMode = () => {
  currentMode = constants.MODE.PRIVATE
  resetSystemMessage()
  refreshMessageFilter()

  // we want to get the message id of the latest message
  // in this private thread, and use that as the root for future messages
  // but if there is no 'latest message' in this thread, we'll
  // set the root after first message sent
  const lastMessage = filteredMessages[filteredMessages.length - 1]
  if (lastMessage) {
    privateMessageRoot = lastMessage.key
  }

  // mark all messages in this conversation as read
  markFilteredMessagesRead()
}
const setPublicMode = () => {
  currentMode = constants.MODE.PUBLIC
  resetPrivateRecipients()
  resetSystemMessage()
  refreshMessageFilter()
}
// #endregion

// #region message actions
const addMessageInPlace = (msg) => {
  const timestamp = msg.rawTime
  // handle edge case
  if (!messages.length || messages[messages.length - 1].rawTime < timestamp) {
    messages.push(msg)
    return
  }
  // find lowest nearest
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].rawTime >= timestamp) {
      messages.splice(i, 0, msg)
      return
    }
  }
}
const refreshMessageFilter = () => {
  if (isPrivateMode()) {
    // if in private mode, only show messages that are either from
    // the person/people i am in private mode with
    // OR from me that i sent to people i'm in private mode with
    filteredMessages = messages.filter(msg => msg.private && compare(msg.recipients || [], privateRecipients))
    return
  }
  filteredMessages = messages.filter(msg => !msg.private)
}
const pushMessage = (msg) => {
  // if a new message comes in, clear any system messages so things don't get confusing
  resetSystemMessage()

  // instead of pushing a message onto the back of the array,
  // we need to put it in the perfect place based on timestamp
  addMessageInPlace(msg)

  if (msg.private) {
    // if we don't already have a root for private messages in this chat,
    // and we're in private mode at this time, we can use this message as the new root
    if (isPrivateMode() && !privateMessageRoot) {
      privateMessageRoot = msg.key
    }

    // also if this wasn't sent by us
    if (msg.recipients && msg.rawAuthor !== me) {
      // see if we're currently in private mode with the recipients
      const talkingToThem = compare(privateRecipients, msg.recipients)

      // if we aren't in private mode
      // or we are in private mode but with other people
      if (!isPrivateMode() || !talkingToThem) {
        // see if these recipients are already in a notification
        const notificationRecipients = msg.recipients.filter(r => r !== me)
        const alreadyNotified = notifications.some(n => compare(n, notificationRecipients))

        // if we haven't already notified about this user sending us something
        if (!alreadyNotified) {
          // and of course confirm that this message isn't already read
          // based on saved read message keys on disk
          if (!isRead(msg)) {
            // then push a notification
            notifications.push(notificationRecipients)
          }
        }
      }
    }
  }

  // and whenever a messages comes in, we should fire off a refresh on our filtered view
  refreshMessageFilter()
}
const getMessages = () => filteredMessages
const pushSystemMessage = (msg) => { systemMessage = msg }
const getSystemMessage = () => systemMessage
const resetSystemMessage = () => { systemMessage = null }
const getPrivateMessageRoot = () => privateMessageRoot
// #endregion

// #region recipient actions
const getPrivateRecipients = () => privateRecipients
const setPrivateRecipients = (recipients) => {
  const uniqueRecipients = new Set(recipients)
  uniqueRecipients.add(me)

  const recipientsArray = [...uniqueRecipients]

  clearNotification(recipientsArray)
  privateRecipients = recipientsArray

  refreshFilteredPrivateRecipients()
  setPrivateMode()
}
const getLastPrivateRecipient = () => lastPrivateRecipient
const refreshFilteredPrivateRecipients = () => {
  filteredPrivateRecipients = privateRecipients.filter(pr => pr !== getMe()).map(getAuthor)
}
const resetPrivateRecipients = () => {
  lastPrivateRecipient = privateRecipients
  privateRecipients = []
  privateMessageRoot = null
  refreshFilteredPrivateRecipients()
}
const getPrivateRecipientsNotMe = () => filteredPrivateRecipients
// #endregion

// #region notification actions
const getNotifications = () => notifications
const getLastNotification = () => notifications[notifications.length - 1] || []
const clearNotification = (recipients) => {
  // when we create a notification, we leave off our own username
  // so to clear a notification we need to take our own username off the criteria
  const filteredRecipients = recipients.filter(r => r !== getMe())
  notifications = notifications.filter(notificationRecipients => !compare(filteredRecipients, notificationRecipients))
}
const resetNotifications = () => { notifications = [] }
// #endregion

// #region read/unread actions
const markAsRead = (message) => {
  const ttl = (message.rawTime + constants.TIME_WINDOW) - Date.now()
  storage.setItemSync(message.key, true, { ttl })
}
const markFilteredMessagesRead = () => {
  filteredMessages.forEach(msg => markAsRead(msg))
}
const isRead = (message) => storage.getItemSync(message.key)

const getLastInput = () => lastInput
const setLastInput = (input) => {
  lastInput = input
}
// #endregion

module.exports = {
  setArgs,
  getArgs,
  setViewport,
  viewPageUp,
  viewPageDown,
  getClient,
  setClient,
  setInput,
  getInputLinesLength,
  getMe,
  getMeNames,
  setMe,
  getAuthor,
  getAuthors,
  getAuthorId,
  setAuthor,
  getMode,
  isPrivateMode,
  setPrivateMode,
  setPublicMode,
  refreshMessageFilter,
  pushMessage,
  getMessages,
  getViewableMessages,
  getWidth,
  getScrolling,
  pushSystemMessage,
  getSystemMessage,
  resetSystemMessage,
  getPrivateMessageRoot,
  getPrivateRecipients,
  getPrivateRecipientsNotMe,
  getLastPrivateRecipient,
  refreshFilteredPrivateRecipients,
  setPrivateRecipients,
  resetPrivateRecipients,
  getNotifications,
  getLastNotification,
  clearNotification,
  resetNotifications,
  getLastInput,
  setLastInput
}
