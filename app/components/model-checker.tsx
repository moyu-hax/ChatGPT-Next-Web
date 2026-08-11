import { useState } from "react";

import { LLMModel } from "../client/api";
import { ServiceProvider } from "../constant";
import ConnectionIcon from "../icons/connection.svg";
import ConfirmIcon from "../icons/confirm.svg";
import CloseIcon from "../icons/close.svg";
import LoadingIcon from "../icons/three-dots.svg";
import ReloadIcon from "../icons/reload.svg";
import Locale from "../locales";
import { useAppConfig } from "../store";
import {
  checkProviderModel,
  checkProviderModels,
  fetchProviderModels,
  ModelCheckResult,
} from "../utils/model-check";
import { IconButton } from "./button";
import { ListItem, showToast } from "./ui-lib";

import styles from "./model-checker.module.scss";

type CheckStatus = "idle" | "checking" | "available" | "unavailable";

type CheckState = {
  status: CheckStatus;
  result?: ModelCheckResult;
};

const PROVIDER = ServiceProvider.OpenAI;

export function AccessCodeModelChecker() {
  const config = useAppConfig();
  const [models, setModels] = useState<LLMModel[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [loadingModels, setLoadingModels] = useState(false);
  const [checkingModel, setCheckingModel] = useState<string>();
  const [checkingAll, setCheckingAll] = useState(false);

  const isBusy = loadingModels || checkingAll || !!checkingModel;

  const updateCheck = (model: string, result: ModelCheckResult) => {
    setChecks((current) => ({
      ...current,
      [model]: {
        status: result.available ? "available" : "unavailable",
        result,
      },
    }));
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const nextModels = await fetchProviderModels(PROVIDER);
      setModels(nextModels);
      setChecks({});
      config.mergeModels(nextModels, PROVIDER);
      showToast(Locale.Settings.ModelCheck.Found(nextModels.length));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast(`${Locale.Settings.ModelCheck.FetchFailed}: ${detail}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const checkOne = async (model: string) => {
    setCheckingModel(model);
    setChecks((current) => ({
      ...current,
      [model]: { status: "checking" },
    }));

    try {
      updateCheck(model, await checkProviderModel(PROVIDER, model));
    } finally {
      setCheckingModel(undefined);
    }
  };

  const checkAll = async () => {
    const modelNames = models.map((model) => model.name);
    let availableCount = 0;
    setCheckingAll(true);
    setChecks(
      Object.fromEntries(
        modelNames.map((model) => [model, { status: "checking" }]),
      ) as Record<string, CheckState>,
    );

    try {
      await checkProviderModels(PROVIDER, modelNames, (model, result) => {
        if (result.available) availableCount += 1;
        updateCheck(model, result);
      });
      showToast(
        Locale.Settings.ModelCheck.BatchComplete(
          availableCount,
          modelNames.length,
        ),
      );
    } finally {
      setCheckingAll(false);
    }
  };

  const getStatusText = (state?: CheckState) => {
    if (!state || state.status === "idle") {
      return Locale.Settings.ModelCheck.Untested;
    }
    if (state.status === "checking") {
      return Locale.Settings.ModelCheck.Checking;
    }
    if (state.status === "available") {
      return `${Locale.Settings.ModelCheck.Available} (${
        state.result?.latency ?? 0
      } ms)`;
    }
    if (state.result?.error === "timeout") {
      return Locale.Settings.ModelCheck.Timeout;
    }
    if (state.result?.error === "invalid_response") {
      return Locale.Settings.ModelCheck.InvalidResponse;
    }
    return state.result?.error || Locale.Settings.ModelCheck.Unavailable;
  };

  return (
    <ListItem
      title={Locale.Settings.ModelCheck.Title}
      subTitle={
        models.length > 0
          ? Locale.Settings.ModelCheck.Count(models.length)
          : Locale.Settings.ModelCheck.SubTitle
      }
      vertical
    >
      <div className={styles["model-checker"]}>
        <div className={styles["model-checker-actions"]}>
          <IconButton
            icon={loadingModels ? <LoadingIcon /> : <ReloadIcon />}
            text={
              loadingModels
                ? Locale.Settings.ModelCheck.Fetching
                : Locale.Settings.ModelCheck.Fetch
            }
            onClick={fetchModels}
            disabled={isBusy}
            bordered
          />
          <IconButton
            icon={checkingAll ? <LoadingIcon /> : <ConnectionIcon />}
            text={
              checkingAll
                ? Locale.Settings.ModelCheck.Checking
                : Locale.Settings.ModelCheck.BatchCheck
            }
            onClick={checkAll}
            disabled={isBusy || models.length === 0}
            bordered
          />
        </div>

        {models.length === 0 ? (
          <div className={styles["model-checker-empty"]}>
            {Locale.Settings.ModelCheck.Empty}
          </div>
        ) : (
          <div className={styles["model-checker-list"]}>
            {models.map((model) => {
              const state = checks[model.name];
              const isChecking = state?.status === "checking";
              return (
                <div className={styles["model-checker-item"]} key={model.name}>
                  <div className={styles["model-checker-info"]}>
                    <div className={styles["model-checker-name"]}>
                      {model.displayName || model.name}
                    </div>
                    <div
                      className={
                        styles[
                          `model-checker-status-${state?.status || "idle"}`
                        ]
                      }
                      title={getStatusText(state)}
                    >
                      {state?.status === "available" && <ConfirmIcon />}
                      {state?.status === "unavailable" && <CloseIcon />}
                      {isChecking && <LoadingIcon />}
                      <span>{getStatusText(state)}</span>
                    </div>
                  </div>
                  <IconButton
                    icon={isChecking ? <LoadingIcon /> : <ConnectionIcon />}
                    text={Locale.Settings.ModelCheck.Check}
                    onClick={() => checkOne(model.name)}
                    disabled={isBusy}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ListItem>
  );
}
