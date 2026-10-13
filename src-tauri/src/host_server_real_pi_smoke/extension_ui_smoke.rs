use super::{read_until, read_until_collect_events, send_json, HostSocket};
use crate::runtime_coordinator::RuntimeTarget;
use serde_json::{json, Value};

pub(super) async fn verify_user_extension_ui_flows(
    socket: &mut HostSocket,
    target: &RuntimeTarget,
) -> Result<(), String> {
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "get-user-extension-commands",
            "target": target,
            "command": { "type": "get_commands" }
        }),
    )
    .await?;
    let commands_response = read_until(socket, |frame| {
        frame["requestId"] == "get-user-extension-commands"
    })
    .await?;
    if commands_response["response"]["success"] != true {
        return Err(format!(
            "Pi get_commands failed through Host: {commands_response}"
        ));
    }
    let commands = commands_response["response"]["data"]["commands"]
        .as_array()
        .ok_or_else(|| format!("Pi extension command catalog missing: {commands_response}"))?;
    let command_names = commands
        .iter()
        .filter_map(|command| command["name"].as_str())
        .collect::<Vec<_>>();
    if !commands.iter().any(|command| {
        command["name"] == "pipline-profile-smoke" && command["source"] == "extension"
    }) || !commands.iter().any(|command| {
        command["name"] == "pipline-profile-confirm" && command["source"] == "extension"
    }) || !commands.iter().any(|command| {
        command["name"] == "pipline-profile-dialogs" && command["source"] == "extension"
    }) || !commands.iter().any(|command| {
        command["name"] == "pipline-profile-input-cancel" && command["source"] == "extension"
    }) || !commands.iter().any(|command| {
        command["name"] == "pipline-profile-custom-ui" && command["source"] == "extension"
    }) {
        return Err(format!(
            "Pi did not auto-load the user extension from PI_CODING_AGENT_DIR; commands: {command_names:?}"
        ));
    }

    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "run-user-extension-command",
            "idempotencyKey": "run-user-extension-command-key",
            "target": target,
            "command": { "type": "prompt", "message": "/pipline-profile-smoke" }
        }),
    )
    .await?;
    let (extension_command_response, extension_events) =
        read_until_collect_events(socket, |frame| {
            frame["requestId"] == "run-user-extension-command"
        })
        .await?;
    if extension_command_response["type"] != "runtime_response"
        || extension_command_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi did not execute the user extension command: {extension_command_response}"
        ));
    }
    let notification = extension_events
        .iter()
        .find(|frame| {
            frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline user extension executed"
        })
        .cloned();
    let notification = if let Some(notification) = notification {
        notification
    } else {
        read_until(socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline user extension executed"
        })
        .await?
    };
    if notification["event"]["message"] != "Pipline user extension executed" {
        return Err(format!(
            "Unexpected user extension UI notification: {notification}"
        ));
    }

    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "run-user-extension-confirm",
            "idempotencyKey": "run-user-extension-confirm-key",
            "target": target,
            "command": { "type": "prompt", "message": "/pipline-profile-confirm" }
        }),
    )
    .await?;
    let confirmation_request = read_until(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "confirm"
            && frame["event"]["title"] == "Pipline extension confirmation"
    })
    .await?;
    let confirmation_id = confirmation_request["event"]["id"]
        .as_str()
        .ok_or("Pi extension confirmation omitted its request id")?;
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "answer-user-extension-confirm",
            "idempotencyKey": "answer-user-extension-confirm-key",
            "target": target,
            "command": { "type": "extension_ui_response", "id": confirmation_id,
                "confirmed": true }
        }),
    )
    .await?;
    let confirmation_response = read_until(socket, |frame| {
        frame["requestId"] == "answer-user-extension-confirm"
    })
    .await?;
    if confirmation_response["type"] != "runtime_response"
        || confirmation_response["response"]["success"] != true
    {
        return Err(format!(
            "Host did not deliver the Pi extension confirmation: {confirmation_response}"
        ));
    }
    let (command_response, later_events) = read_until_collect_events(socket, |frame| {
        frame["requestId"] == "run-user-extension-confirm"
    })
    .await?;
    if command_response["type"] != "runtime_response"
        || command_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi extension command did not resume after confirmation: {command_response}"
        ));
    }
    let confirmation_notice = later_events
        .iter()
        .find(|frame| {
            frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline confirmation result: true"
        })
        .cloned();
    let confirmation_notice = if let Some(notice) = confirmation_notice {
        notice
    } else {
        read_until(socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline confirmation result: true"
        })
        .await?
    };
    if confirmation_notice["event"]["message"] != "Pipline confirmation result: true" {
        return Err(format!(
            "Pi extension did not continue with the confirmed result: {confirmation_notice}"
        ));
    }

    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "run-user-extension-dialogs",
            "idempotencyKey": "run-user-extension-dialogs-key",
            "target": target,
            "command": { "type": "prompt", "message": "/pipline-profile-dialogs" }
        }),
    )
    .await?;
    let select_request = read_until(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "select"
            && frame["event"]["title"] == "Choose a profile value"
    })
    .await?;
    let select_id = select_request["event"]["id"]
        .as_str()
        .ok_or("Pi extension select omitted its request id")?;
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "answer-user-extension-select",
            "idempotencyKey": "answer-user-extension-select-key",
            "target": target,
            "command": { "type": "extension_ui_response", "id": select_id, "value": "B" }
        }),
    )
    .await?;
    let select_response = read_until(socket, |frame| {
        frame["requestId"] == "answer-user-extension-select"
    })
    .await?;
    if select_response["type"] != "runtime_response"
        || select_response["response"]["success"] != true
    {
        return Err(format!(
            "Host did not deliver Pi select value: {select_response}"
        ));
    }
    let input_request = read_until(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "input"
            && frame["event"]["title"] == "Enter a profile value"
    })
    .await?;
    let input_id = input_request["event"]["id"]
        .as_str()
        .ok_or("Pi extension input omitted its request id")?;
    let expected_input_value = "Pipline [OK]";
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "answer-user-extension-input",
            "idempotencyKey": "answer-user-extension-input-key",
            "target": target,
            "command": { "type": "extension_ui_response", "id": input_id, "value": expected_input_value }
        }),
    )
    .await?;
    let input_response = read_until(socket, |frame| {
        frame["requestId"] == "answer-user-extension-input"
    })
    .await?;
    if input_response["type"] != "runtime_response" || input_response["response"]["success"] != true
    {
        return Err(format!(
            "Host did not deliver Pi input value: {input_response}"
        ));
    }
    let (dialogs_response, dialogs_events) = read_until_collect_events(socket, |frame| {
        frame["requestId"] == "run-user-extension-dialogs"
    })
    .await?;
    if dialogs_response["type"] != "runtime_response"
        || dialogs_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi dialog extension did not resume: {dialogs_response}"
        ));
    }
    let expected_dialog_result =
        "Pipline dialog results: {\"choice\":\"B\",\"value\":\"Pipline [OK]\"}";
    let dialog_notice = dialogs_events
        .iter()
        .find(|frame| {
            frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == expected_dialog_result
        })
        .cloned();
    let dialog_notice = if let Some(notice) = dialog_notice {
        notice
    } else {
        read_until(socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == expected_dialog_result
        })
        .await?
    };
    if dialog_notice["event"]["message"] != expected_dialog_result {
        return Err(format!(
            "Pi extension returned unexpected dialog values: {dialog_notice}"
        ));
    }

    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "run-user-extension-input-cancel",
            "idempotencyKey": "run-user-extension-input-cancel-key",
            "target": target,
            "command": { "type": "prompt", "message": "/pipline-profile-input-cancel" }
        }),
    )
    .await?;
    let cancel_request = read_until(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "input"
            && frame["event"]["title"] == "Cancel a profile value"
    })
    .await?;
    let cancel_id = cancel_request["event"]["id"]
        .as_str()
        .ok_or("Pi extension cancellation input omitted its request id")?;
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "answer-user-extension-input-cancel",
            "idempotencyKey": "answer-user-extension-input-cancel-key",
            "target": target,
            "command": { "type": "extension_ui_response", "id": cancel_id, "cancelled": true }
        }),
    )
    .await?;
    let cancel_response = read_until(socket, |frame| {
        frame["requestId"] == "answer-user-extension-input-cancel"
    })
    .await?;
    if cancel_response["type"] != "runtime_response"
        || cancel_response["response"]["success"] != true
    {
        return Err(format!(
            "Host did not deliver Pi input cancellation: {cancel_response}"
        ));
    }
    let (cancelled_command_response, cancelled_events) =
        read_until_collect_events(socket, |frame| {
            frame["requestId"] == "run-user-extension-input-cancel"
        })
        .await?;
    if cancelled_command_response["type"] != "runtime_response"
        || cancelled_command_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi extension did not resume after cancellation: {cancelled_command_response}"
        ));
    }
    let cancellation_notice = cancelled_events
        .iter()
        .find(|frame| {
            frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline input cancelled"
        })
        .cloned();
    let cancellation_notice = if let Some(notice) = cancellation_notice {
        notice
    } else {
        read_until(socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == "Pipline input cancelled"
        })
        .await?
    };
    if cancellation_notice["event"]["message"] != "Pipline input cancelled" {
        return Err(format!(
            "Pi extension returned the wrong cancellation result: {cancellation_notice}"
        ));
    }

    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "run-user-extension-custom-ui",
            "idempotencyKey": "run-user-extension-custom-ui-key",
            "target": target,
            "command": { "type": "prompt", "message": "/pipline-profile-custom-ui" }
        }),
    )
    .await?;
    let custom_ui_open = read_until(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "notify"
            && frame["event"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("__picotCustomUi"))
    })
    .await?;
    let custom_ui_payload: Value = serde_json::from_str(
        custom_ui_open["event"]["message"]
            .as_str()
            .ok_or("custom UI notification did not contain text")?,
    )
    .map_err(|error| format!("decode custom UI notification: {error}"))?;
    if custom_ui_payload["__picotCustomUi"]["op"] != "open"
        || custom_ui_payload["__picotCustomUi"]["lines"][0] != "Pipline custom panel"
    {
        return Err(format!(
            "Pi custom UI did not render through Host: {custom_ui_payload}"
        ));
    }
    let custom_ui_id = custom_ui_payload["__picotCustomUi"]["id"]
        .as_str()
        .ok_or("custom UI open frame omitted its panel id")?;
    send_json(
        socket,
        json!({
            "type": "runtime_request",
            "requestId": "send-user-extension-custom-ui-input",
            "idempotencyKey": "send-user-extension-custom-ui-input-key",
            "target": target,
            "command": {
                "type": "prompt",
                "message": format!(
                    "/picot-custom-ui {{\"id\":\"{custom_ui_id}\",\"data\":\"b\"}}"
                )
            }
        }),
    )
    .await?;
    let custom_input_response = read_until(socket, |frame| {
        frame["requestId"] == "send-user-extension-custom-ui-input"
    })
    .await?;
    if custom_input_response["type"] != "runtime_response"
        || custom_input_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi did not accept custom UI input through Host: {custom_input_response}"
        ));
    }
    let (custom_ui_response, custom_ui_events) = read_until_collect_events(socket, |frame| {
        frame["requestId"] == "run-user-extension-custom-ui"
    })
    .await?;
    if custom_ui_response["type"] != "runtime_response"
        || custom_ui_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi extension remained blocked after custom UI input: {custom_ui_response}"
        ));
    }
    let expected_custom_result = "Pipline custom UI result: selected";
    if !custom_ui_events.iter().any(|frame| {
        frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "notify"
            && frame["event"]["message"] == expected_custom_result
    }) {
        let custom_ui_result = read_until(socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == expected_custom_result
        })
        .await?;
        if custom_ui_result["event"]["message"] != expected_custom_result {
            return Err(format!(
                "Pi custom UI returned an unexpected result: {custom_ui_result}"
            ));
        }
    }
    Ok(())
}
