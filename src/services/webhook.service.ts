import Chatwork, { PostRoomMessageResponse } from '@utils/chatwork';
import { GITHUB_ACTION, GithubDto } from '@dtos/github.dto';
import { isEmpty } from '@/utils/util';
import { HttpException } from '@exceptions/HttpException';
import { StatusCodes } from '@utils/status-code';
import { MESSAGES } from '@/constants/messages';
import { compileTemplate, Options } from '@utils/template';
import { EVENT, PR_TEMPLATE } from '@/constants/commons';
import { Prisma, PrismaClient, Webhook } from '@prisma/client';
import { logger } from '@utils/logger';
import { GITHUB_EVENT } from '@/constants/headers';

class WebhookService {
  public webhooks = new PrismaClient().webhook;
  private chatwork = new Chatwork();

  public async github(key: string, eventData: GithubDto): Promise<any> {
    if (isEmpty(eventData)) throw new HttpException(StatusCodes.BAD_REQUEST, MESSAGES.REQUEST_BODY_REQUIRED);
    const webhook = await this.findByKey(key);
    console.log(webhook);

    // Set specify chatwork token
    this.chatwork.apiToken = this.getChatworkToken(webhook);

    const room = this.getRoom(webhook);
    const { receivers } = this.getSenderAndReceivers(room.members, eventData);

    // Don't send notification when receivers empty
    if (!receivers) {
      return;
    }

    // Send notification
    let messageRes = undefined;
    if (this.event(eventData) === EVENT.COMMENT_CREATED) {
      messageRes = this.notifyCommentCreated(room.room_id, room.members, receivers, eventData);
    } else if (this.event(eventData) === EVENT.COMMENT_EDITED) {
      messageRes = this.notifyCommentEdited(room.room_id, room.members, receivers, eventData);
    } else if (this.event(eventData) === EVENT.PULL_REQUEST_OPENED) {
      messageRes = this.notifyPullRequestOpen(room.room_id, room.members, receivers, eventData);
    } else if (this.event(eventData) === EVENT.PULL_REQUEST_MERGED) {
      messageRes = this.notifyPullRequestMerged(room.room_id, room.members, receivers, eventData);
    } else if (this.event(eventData) === EVENT.PULL_REQUEST_CLOSED) {
      messageRes = this.notifyPullRequestClosed(room.room_id, room.members, receivers, eventData);
    } else if (this.event(eventData) === EVENT.PULL_REQUEST_REOPENED) {
      messageRes = this.notifyPullRequestReopen(room.room_id, room.members, receivers, eventData);
    }

    return messageRes;
  }

  private event(eventData: GithubDto): EVENT {
    let event;
    if (eventData.event === GITHUB_EVENT.PULL_REQUEST) {
      if (eventData.action === GITHUB_ACTION.opened) {
        // Open pull request
        event = EVENT.PULL_REQUEST_OPENED;
      } else if (eventData.action === GITHUB_ACTION.closed) {
        if (eventData.pull_request.merged) {
          // Merge pull request
          event = EVENT.PULL_REQUEST_MERGED;
        } else {
          // Close pull request
          event = EVENT.PULL_REQUEST_CLOSED;
        }
      } else if (eventData.action === GITHUB_ACTION.reopened) {
        // Reopen pull request
        event = EVENT.PULL_REQUEST_REOPENED;
      }
    } else if (eventData.event === GITHUB_EVENT.PULL_REQUEST_REVIEW_COMMENT) {
      if (eventData.action === GITHUB_ACTION.created) {
        // New comment
        event = EVENT.COMMENT_CREATED;
      } else if (eventData.action === GITHUB_ACTION.edited) {
        // Edit comment
        event = EVENT.COMMENT_EDITED;
      }
    }

    return event;
  }

  public async findByKey(serviceKey: string): Promise<Webhook> {
    const item: Webhook = await this.webhooks.findUnique({ where: { service_key: serviceKey } });
    if (!item) throw new HttpException(StatusCodes.CONFLICT, MESSAGES.WEBHOOK_NOT_FOUND);

    return item;
  }

  public getChatworkToken(webhook: Webhook): string {
    if (isEmpty(webhook)) throw new HttpException(StatusCodes.CONFLICT, MESSAGES.WEBHOOK_NOT_FOUND);
    if (webhook?.bot && typeof webhook?.bot === 'object') {
      const bot = webhook.bot as Prisma.JsonObject;
      return bot.chatwork_token as string;
    }

    return null;
  }

  public getSlackToken(webhook: Webhook): string {
    if (isEmpty(webhook)) throw new HttpException(StatusCodes.CONFLICT, MESSAGES.WEBHOOK_NOT_FOUND);
    if (webhook?.bot && typeof webhook?.bot === 'object') {
      const bot = webhook.bot as Prisma.JsonObject;
      return bot.slack_token as string;
    }

    return null;
  }

  public getRoom(webhook: Webhook): any {
    if (isEmpty(webhook)) throw new HttpException(StatusCodes.CONFLICT, MESSAGES.WEBHOOK_NOT_FOUND);

    if (webhook?.room && typeof webhook?.room === 'object') {
      const room = webhook.room as Prisma.JsonObject;
      if (isEmpty(room)) throw new HttpException(StatusCodes.CONFLICT, MESSAGES.ROOM_UNDEFINED);
      return room;
    }
  }

  public getSenderAndReceivers(members: any[], eventData: GithubDto): any {
    let sender;
    let receivers;

    if (this.event(eventData) === EVENT.COMMENT_CREATED || this.event(eventData) === EVENT.COMMENT_EDITED) {
      sender = eventData.comment.user.login;
      let mentions = eventData.comment.body.match(/(@\S+)(?!.*\1)/g);
      mentions = mentions?.map(i => i.replace('@', ''));
      receivers = members
        .map(member => {
          if (mentions?.includes(member.github_id)) return `[To:${member.chatwork_id}]`;
        })
        .join('');
    } else if (
      this.event(eventData) === EVENT.PULL_REQUEST_OPENED ||
      this.event(eventData) === EVENT.PULL_REQUEST_MERGED ||
      this.event(eventData) === EVENT.PULL_REQUEST_CLOSED ||
      this.event(eventData) === EVENT.PULL_REQUEST_REOPENED
    ) {
      sender = eventData.pull_request.user.login;
      const assignees = eventData.pull_request.assignees.map(o => o.login);
      if (assignees.length == 0) {
        receivers = members.map(member => `[To:${member.chatwork_id}]`).join('');
      } else {
        receivers = members
          .map(member => {
            if (assignees?.includes(member.github_id)) return `[To:${member.chatwork_id}]`;
          })
          .join('');
      }
    }

    return { sender, receivers };
  }

  public getChatworkId(members: any[], githubId: string): string {
    return members.find(item => item.github_id === githubId)?.chatwork_id;
  }

  private notifyPullRequestOpen(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      pull_request_url: eventData.pull_request.html_url,
      pull_request_body: eventData.pull_request.body,
      pull_request_edited_files: (eventData.pull_request.changed_files || 0).toString(),
      pull_request_added_lines: (eventData.pull_request.additions || 0).toString(),
      pull_request_deleted_lines: (eventData.pull_request.deletions || 0).toString(),
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_PULL_REQUEST_OPENED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private notifyPullRequestMerged(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      pull_request_url: eventData.pull_request.html_url,
      pull_request_body: eventData.pull_request.body,
      pull_request_edited_files: (eventData.pull_request.changed_files || 0).toString(),
      pull_request_added_lines: (eventData.pull_request.additions || 0).toString(),
      pull_request_deleted_lines: (eventData.pull_request.deletions || 0).toString(),
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_PULL_REQUEST_MERGED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private notifyPullRequestReopen(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      pull_request_url: eventData.pull_request.html_url,
      pull_request_body: eventData.pull_request.body,
      pull_request_edited_files: (eventData.pull_request.changed_files || 0).toString(),
      pull_request_added_lines: (eventData.pull_request.additions || 0).toString(),
      pull_request_deleted_lines: (eventData.pull_request.deletions || 0).toString(),
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_PULL_REQUEST_REOPENED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private notifyPullRequestClosed(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      pull_request_url: eventData.pull_request.html_url,
      pull_request_body: eventData.pull_request.body,
      pull_request_edited_files: (eventData.pull_request.changed_files || 0).toString(),
      pull_request_added_lines: (eventData.pull_request.additions || 0).toString(),
      pull_request_deleted_lines: (eventData.pull_request.deletions || 0).toString(),
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_PULL_REQUEST_CLOSED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private notifyCommentCreated(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      commentator: this.getChatworkId(members, eventData.comment.user.login),
      comment_body: eventData.comment.body,
      comment_url: eventData.comment.html_url,
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_COMMENT_CREATED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private notifyCommentEdited(roomId: string, members: any[], receivers: string, eventData: GithubDto) {
    const options: Options = {
      repository_name: eventData.repository.name,
      pull_request_title: eventData.pull_request.title,
      pull_request_owner: this.getChatworkId(members, eventData.pull_request.user.login),
      commentator: this.getChatworkId(members, eventData.comment.user.login),
      comment_body: eventData.comment.body,
      comment_url: eventData.comment.html_url,
      receivers: receivers,
    };

    const message = compileTemplate(PR_TEMPLATE.CHATWORK_COMMENT_EDITED, options);
    return this.sendChatworkMessage(roomId, message);
  }

  private sendChatworkMessage(roomId: string, message: string): Promise<PostRoomMessageResponse | void> {
    return this.chatwork
      .postRoomMessage(roomId, {
        body: message,
        self_unread: 0,
      })
      .then(data => {
        return data;
      })
      .catch(err => {
        console.log(err);
        if (err.response.status === StatusCodes.UNAUTHORIZED || err.response.status === StatusCodes.BAD_REQUEST) {
          logger.info(`Chatwork: roomId=${roomId}`);
          throw new HttpException(StatusCodes.BAD_REQUEST, `${MESSAGES.CHATWORK_REQUEST_FAILURE}: ${err.response.data?.errors[0]}`);
        }
        throw err;
      });
  }
}

export default WebhookService;
